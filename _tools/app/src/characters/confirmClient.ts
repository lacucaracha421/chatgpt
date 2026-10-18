import { invoke } from "@tauri-apps/api/core";
import type { CharacterTarget } from "./api";
import { mergeConfirmItems, type ConfirmItem, type ConfirmKind } from "./confirmModel";
import { shadowItemKey, shadowReviewApi, type ShadowReviewApi, type ShadowReviewItem, type ShadowReviewMode } from "./shadowReviewApi";
import type { TaggerReviewItem } from "./taggerReviewClient";

/** The scope a 확인 list opens on: everything, one series, or one character (a character knows its series). */
export type ConfirmScope = { series?: { id: string; name: string }; target?: { id: string; name: string } };

/** Pending items of the one list, each (character, image) pair once under its highest kind: the cheap count behind a series' "확인 N" and Home's total. */
export type ConfirmKindCounts = { recognition: number; tag: number; recheck: number };

export interface ConfirmSources {
  /** The complete pending tag list (one read). */
  tagger(): Promise<readonly TaggerReviewItem[]>;
  members?(): Promise<readonly ShadowReviewItem[]>;
  /** Exact pending counts, for the whole library or one series. */
  counts(seriesId?: string): Promise<ConfirmKindCounts>;
  shadow: Pick<ShadowReviewApi, "page"> & Partial<Pick<ShadowReviewApi, "inboundStatus">>;
}

export const confirmSources: ConfirmSources = {
  tagger: () => invoke<TaggerReviewItem[]>("tagger_review_items"),
  members: () => invoke<ShadowReviewItem[]>("claude_member_recommendations"),
  counts: seriesId => invoke<ConfirmKindCounts>("character_confirm_counts", { seriesId: seriesId ?? null }),
  shadow: shadowReviewApi,
};

export const confirmTotal = (counts: ConfirmKindCounts) => counts.recognition + counts.tag + counts.recheck;

/** The native page maximum. */
const PAGE = 200;

/** Every page of one shadow list; a page with nothing new means the order shifted under the read, so it stops. */
export async function readShadowList(api: Pick<ShadowReviewApi, "page">, mode: ShadowReviewMode, seriesId: string | undefined, isLive: () => boolean = () => true): Promise<ShadowReviewItem[] | null> {
  const seen = new Set<string>();
  const items: ShadowReviewItem[] = [];
  let offset: number | null = 0;
  while (offset !== null) {
    const page = await api.page({ offset, limit: PAGE, ...(mode === "doubtful" ? { mode } : {}), ...(seriesId ? { seriesId } : {}) });
    if (!isLive()) return null;
    let fresh = 0;
    for (const item of page.items ?? []) {
      const key = shadowItemKey(item);
      if (seen.has(key)) continue;
      seen.add(key); fresh += 1;
      items.push(item);
    }
    offset = fresh > 0 ? page.nextOffset : null;
  }
  return items;
}

export type ConfirmRead = {
  items: ConfirmItem[];
  /** Learning suggestions separated for the overview's bottom group; review dialogs include both partitions. Empty for a single-character scope. */
  folded: ConfirmItem[];
  /** The kinds whose list could not be read this time. */
  failed: ConfirmKind[];
};

/** Review every pending item; the overview alone keeps learning suggestions in its bottom group. */
export const confirmReviewItems = (read: ConfirmRead) => [...read.items, ...read.folded];

// Reuse the overview's existing full read for continuation; opening a scoped dialog
// must not trigger another library-wide scan just to offer the next character.
const overviewReads = new WeakMap<ConfirmSources, ConfirmRead>();
export const getConfirmOverviewRead = (sources: ConfirmSources): ConfirmRead | undefined => overviewReads.get(sources);

/**
 * Reads the three lists for one scope and merges them. A list that fails is reported in `failed` and the
 * others still show. Resolves null when `isLive` turned false (the reader is no longer wanted).
 */
export async function readConfirmItems(sources: ConfirmSources, scope: ConfirmScope, targets: readonly CharacterTarget[], isLive: () => boolean = () => true): Promise<ConfirmRead | null> {
  const failed: ConfirmKind[] = [];
  const attempt = async <T,>(kind: ConfirmKind, read: () => Promise<T>, empty: T): Promise<T> => {
    try { return await read(); } catch { if (!failed.includes(kind)) failed.push(kind); return empty; }
  };
  const seriesId = scope.series?.id;
  const [tagger, candidates, doubtful, members] = await Promise.all([
    attempt<readonly TaggerReviewItem[]>("tag", () => sources.tagger(), []),
    attempt<ShadowReviewItem[] | null>("recognition", () => readShadowList(sources.shadow, "candidates", seriesId, isLive), []),
    attempt<ShadowReviewItem[] | null>("recheck", () => readShadowList(sources.shadow, "doubtful", seriesId, isLive), []),
    attempt<readonly ShadowReviewItem[]>("recognition", () => sources.members?.() ?? Promise.resolve([]), []),
  ]);
  if (!isLive() || !candidates || !doubtful) return null;
  const inScope = <T extends { targetId: string }>(items: readonly T[]) => scope.target ? items.filter(item => item.targetId === scope.target!.id) : items;
  const tagItems = tagger.filter(item => (!seriesId || item.seriesId === seriesId));
  // Separate learning suggestions for overview grouping; a single-character read needs no partition.
  const fold = !scope.target;
  const memberIds = new Set(members.map(item => shadowItemKey(item)));
  const allCandidates = [...members.filter(item => !seriesId || targets.find(t => t.id === item.targetId)?.seriesClassificationId === seriesId), ...candidates.filter(item => !memberIds.has(shadowItemKey(item)))];
  const shown = inScope(allCandidates).filter(item => !(fold && item.folded));
  const items = mergeConfirmItems({ tagger: inScope(tagItems), candidates: shown, doubtful: inScope(doubtful), targets });
  const have = new Set(items.map(item => item.key));
  const folded = fold ? mergeConfirmItems({ tagger: [], candidates: inScope(allCandidates).filter(item => item.folded), doubtful: [], targets }).filter(item => !have.has(item.key)) : [];
  const read = { items, folded, failed };
  if (!scope.series && !scope.target) overviewReads.set(sources, read);
  return read;
}
