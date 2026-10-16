import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { workArtworkThumbnailUrl } from "../assets/mediaUrl";
import type { CollectionSummary, LibraryGateway } from "../library/types";
import { beginNativePhase } from "../shared/nativePerf";
import { avGateway } from "./avClient";
import { workCasePlatform } from "./case/CollectionCase";
import { readShelfInfo, rememberedShelfInfo, sameShelfInfo, shelfInfoKey, type ShelfInfo } from "./case/shelfCaseInfo";
import { collectionCredit } from "./collectionFormat";
import type { SpineWork } from "./SpineShelf";
import { decodeSpine, isSpineWarm, warmSpines } from "./spineShelfWarm";

type AvArt = { front: string | null; spine: string | null };
/** The last read per library and work, so a shelf that mounts again prints its spines at once. */
const rememberedAvArt = new Map<string, AvArt>();
const spineUrl = (artworkId: string | null, revision: string) => artworkId ? `${workArtworkThumbnailUrl(artworkId)}?v=${encodeURIComponent(revision)}` : null;
const avArtKey = (root: string, collection: Pick<CollectionSummary, "id" | "updatedAt">) => JSON.stringify([root, collection.id, collection.updatedAt]);
/** Longest the shelf waits for the owned devices before it draws with what the list says. */
const SHELF_INFO_CAP_MS = 400;
/** Test seam. */
export function resetSpineShelfDataForTests() { rememberedAvArt.clear(); }

type Options = {
  /** Off for the other layouts and types: nothing is read. */
  enabled: boolean;
  gateway: LibraryGateway;
  root: string;
  privacy: boolean;
  /** The front cover URL of a work (shown when its case is pulled out). */
  coverUrl(collection: CollectionSummary): string | null;
  /** Changes when artwork may have changed behind the list (a 책등 받기 run ended). */
  refreshKey?: unknown;
};

/**
 * The works of a game or AV 책장. A game's owned device decides its case size, so the whole list is read in one
 * batched call and the shelf waits for it (capped) before its rows are laid out; the spine artwork comes with it.
 * AV cases are all one size, so their artwork is read in one batch per mounted window of rows, and a spine stays
 * plastic until its artwork has arrived.
 */
export function useSpineShelfWorks(collections: CollectionSummary[], type: "game" | "av", { enabled, gateway, root, privacy, coverUrl, refreshKey }: Options) {
  const [games, setGames] = useState<Map<string, ShelfInfo>>(() => new Map());
  const [capped, setCapped] = useState(false);
  const [avArt, setAvArt] = useState<Map<string, AvArt>>(() => new Map());
  const requested = useRef(new Set<string>());
  const reading = useRef(new Map<string, Promise<void>>());
  const [avFailed, setAvFailed] = useState<Set<string>>(() => new Set());

  const gameSignature = useMemo(() => enabled && type === "game" ? JSON.stringify([root, collections.map(item => [item.id, item.updatedAt])]) : "", [enabled, type, root, collections]);
  useEffect(() => {
    if (!enabled || type !== "game") return;
    let current = true;
    setCapped(false);
    const timer = window.setTimeout(() => { if (current) setCapped(true); }, SHELF_INFO_CAP_MS);
    void Promise.all(collections.map(item => readShelfInfo(gateway, root, item.id).then(info => [item.id, info] as const, () => null))).then(entries => {
      if (!current) return;
      setGames(before => {
        const next = new Map<string, ShelfInfo>();
        let changed = before.size !== entries.length;
        for (const entry of entries) {
          if (!entry) continue;
          next.set(entry[0], entry[1]);
          if (!sameShelfInfo(before.get(entry[0]), entry[1])) changed = true;
        }
        return changed ? next : before;
      });
      window.clearTimeout(timer); setCapped(true);
    });
    return () => { current = false; window.clearTimeout(timer); };
    // The list is read again when its works or a 책등 받기 run change.
  }, [enabled, gameSignature, gateway, refreshKey]); // eslint-disable-line react-hooks/exhaustive-deps

  const infoOf = useCallback((id: string) => games.get(id) ?? rememberedShelfInfo(shelfInfoKey(root, id)), [games, root]);
  const settled = !enabled || type !== "game" || capped || collections.every(item => infoOf(item.id));

  const infoRef = useRef(infoOf); infoRef.current = infoOf;
  const byId = useRef(new Map<string, CollectionSummary>());
  byId.current = new Map(collections.map(item => [item.id, item]));
  /**
   * Reads the cover sets of the works not read yet, in one call, and resolves when they have arrived (or failed).
   * A work already being read is joined, and a failed one is not asked again.
   */
  const loadCovers = useCallback((items: CollectionSummary[]): Promise<void> => {
    const waits: Promise<void>[] = [], wanted: CollectionSummary[] = [];
    for (const item of items) {
      const key = avArtKey(root, item);
      if (rememberedAvArt.has(key)) continue;
      const running = reading.current.get(key);
      if (running) waits.push(running);
      else if (!requested.current.has(key)) wanted.push(item);
    }
    if (wanted.length) {
      const phase = beginNativePhase("collections.ipc.list_av_cover_sets");
      const read = avGateway.listCoverSets
        ? avGateway.listCoverSets(wanted.map(item => item.id))
        : Promise.all(wanted.map(item => avGateway.getCoverSet(item.id).then(set => ({ ...set, collectionId: item.id }), () => null))).then(sets => sets.flatMap(set => set ? [set] : []));
      const batch = read.then(sets => {
        phase?.mark("arrived");
        const found = new Map(sets.map(set => [set.collectionId, set]));
        const failed: string[] = [], arrived = new Map<string, AvArt>();
        for (const item of wanted) {
          const set = found.get(item.id), key = avArtKey(root, item);
          if (!set) { failed.push(key); continue; }
          const art = { front: spineUrl(set.frontId, set.revision), spine: spineUrl(set.spineId, set.revision) };
          rememberedAvArt.delete(key); rememberedAvArt.set(key, art);
          if (rememberedAvArt.size > 2048) rememberedAvArt.delete(rememberedAvArt.keys().next().value!);
          arrived.set(key, art);
        }
        setAvArt(before => new Map([...before, ...arrived]));
        if (failed.length) setAvFailed(before => new Set([...before, ...failed]));
      }, () => {
        phase?.mark("failed");
        // Existing front artwork and the plain spine remain available.
        setAvFailed(before => new Set([...before, ...wanted.map(item => avArtKey(root, item))]));
      }).finally(() => {
        phase?.cancel();
        wanted.forEach(item => reading.current.delete(avArtKey(root, item)));
      });
      wanted.forEach(item => { const key = avArtKey(root, item); requested.current.add(key); reading.current.set(key, batch); });
      waits.push(batch);
    }
    return Promise.all(waits).then(() => undefined);
  }, [root]);

  const spineOf = useCallback((id: string): string | null => {
    const item = byId.current.get(id);
    if (!item) return null;
    if (type === "av") return rememberedAvArt.get(avArtKey(root, item))?.spine ?? null;
    const artworkId = infoRef.current(id)?.spineArtworkId;
    return artworkId ? workArtworkThumbnailUrl(artworkId) : null;
  }, [type, root]);

  /** The works near the viewport: their cover sets are read, then their spines decoded a few at a time. */
  const onWindow = useCallback((ids: string[]) => {
    if (!enabled || type !== "av" || privacy) return;
    const items = ids.flatMap(id => byId.current.get(id) ?? []);
    void loadCovers(items).then(() => warmSpines(ids.flatMap(id => spineOf(id) ?? [])));
  }, [enabled, type, privacy, loadCovers, spineOf]);

  /**
   * The first screen of a changed list: AV cover sets arrive, then the spines on screen are decoded. Returns nothing
   * when all of that is done already (a list seen before), so the shelf swaps without waiting.
   */
  const prepare = useCallback((ids: string[], visible: string[], signal: AbortSignal) => {
    const items = type === "av" ? ids.flatMap(id => byId.current.get(id) ?? []) : [];
    const unread = items.some(item => { const key = avArtKey(root, item); return !rememberedAvArt.has(key) && (reading.current.has(key) || !requested.current.has(key)); });
    const cold = () => visible.flatMap(id => spineOf(id) ?? []).filter(url => !isSpineWarm(url));
    if (!unread && !cold().length) return;
    return (async () => {
      if (unread) await loadCovers(items);
      if (!signal.aborted) await Promise.all(cold().map(decodeSpine));
    })();
  }, [type, root, loadCovers, spineOf]);

  const toWork = useCallback((item: CollectionSummary): SpineWork => {
    const base = { id: item.id, title: item.name, credit: collectionCredit(item), developer: item.developer ?? null };
    if (type === "av") {
      const key = avArtKey(root, item), art = avArt.get(key) ?? rememberedAvArt.get(key);
      return { ...base, platform: "av", front: art?.front ?? coverUrl(item), spine: art?.spine ?? null, pending: !privacy && !art && !avFailed.has(key) };
    }
    const info = infoOf(item.id);
    return { ...base, platform: workCasePlatform("game", item.platforms, info?.ownedPlatform), front: coverUrl(item),
      spine: info?.spineArtworkId ? workArtworkThumbnailUrl(info.spineArtworkId) : null, pending: !privacy && !info };
  }, [type, root, avArt, avFailed, infoOf, coverUrl, privacy]);

  // Only a shelf that reads artwork lazily has anything to wait for; privacy draws no artwork at all.
  const preparing = enabled && !privacy ? prepare : undefined;
  return { toWork, onWindow, prepare: preparing, settled };
}
