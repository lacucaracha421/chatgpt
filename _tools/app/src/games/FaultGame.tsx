import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode, type SVGProps } from "react";
import { createPortal } from "react-dom";
import { assetUrl } from "../assets/mediaUrl";
import type { AssetQuery, AssetSummary, LibraryGateway } from "../library/types";
import { usePrivacy } from "../privacy/PrivacyContext";
import { Button } from "../shared/ui/Button";
import type { ContextMenuItem } from "../shared/ui/ContextMenu";
import { connectFaultFrame, faultCandidates, faultGameUrl, FAULT_MAX_PHOTOS, pickRandom, type FaultPhoto } from "./fault/host";
import "./FaultGame.css";

/** Loads the assets a session draws from; the overlay keeps only up to 24 still images of them. */
export type FaultScope = (signal: AbortSignal) => Promise<readonly AssetSummary[]>;
type Play = (scope: FaultScope) => void;

const FaultContext = createContext<Play | null>(null);

/** Known extensions the game converts; other extensions are declared as-is so the game's type check excludes them. */
const IMAGE_TYPES: Record<string, string> = { jpg: "image/jpeg", jpeg: "image/jpeg", jfif: "image/jpeg", jpe: "image/jpeg", png: "image/png", webp: "image/webp", gif: "image/gif", avif: "image/avif", bmp: "image/bmp" };

function imageType(name: string): string | null {
  const extension = /\.([a-z0-9]+)$/i.exec(name)?.[1]?.toLowerCase();
  return extension ? IMAGE_TYPES[extension] ?? `image/${extension}` : null;
}

/** Still images the game can convert: videos, unsupported formats and oversized originals are left out. */
export function faultAssets(items: readonly AssetSummary[]): AssetSummary[] {
  return faultCandidates(items.map((asset) => ({ id: asset.id, kind: asset.media.kind === "video" ? "video" : "image", content_type: imageType(asset.originalName), size_bytes: asset.byteSize, asset })))
    .map(({ asset }) => asset);
}

async function mapBounded<T, R>(items: readonly T[], limit: number, work: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) { const index = next++; results[index] = await work(items[index]!); }
  }));
  return results;
}

/**
 * Up to 24 random playable images of `items`, read from the app's original-media route.
 * Unreadable images are skipped; an empty result means nothing could be read.
 */
export async function loadFaultPhotos(items: readonly AssetSummary[], signal?: AbortSignal, random: () => number = Math.random): Promise<FaultPhoto[]> {
  const chosen = pickRandom(faultAssets(items), FAULT_MAX_PHOTOS, random);
  const loaded = await mapBounded(chosen, 3, async (asset) => {
    try {
      const response = await fetch(assetUrl(asset.id), { signal });
      if (!response.ok) return null;
      const data = await response.blob();
      if (!data.size) return null;
      // The game checks the declared type before converting, so a typeless body gets the file's.
      const blob = data.type ? data : data.slice(0, data.size, imageType(asset.originalName) ?? "image/jpeg");
      return { id: asset.id, blob } satisfies FaultPhoto;
    } catch (error) {
      if (signal?.aborted) throw error;
      return null;
    }
  });
  return loaded.filter((photo): photo is { id: string; blob: Blob } => photo !== null);
}

/**
 * Hosts the FAULT game above the whole workspace. The workspace stays mounted (and inert) underneath,
 * so closing the game returns to exactly the same view. Nothing is offered while privacy mode is on.
 */
export function FaultGameProvider({ children }: { children: ReactNode }) {
  const { privacyMode } = usePrivacy();
  const [session, setSession] = useState<{ id: number; scope: FaultScope } | null>(null);
  const returnFocus = useRef<HTMLElement | null>(null);
  const play = useCallback<Play>((scope) => {
    returnFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setSession((current) => ({ id: (current?.id ?? 0) + 1, scope }));
  }, []);
  const close = useCallback(() => setSession(null), []);
  useEffect(() => { if (privacyMode) setSession(null); }, [privacyMode]);
  useEffect(() => {
    if (session) return;
    const target = returnFocus.current;
    returnFocus.current = null;
    if (target?.isConnected) target.focus({ preventScroll: true });
  }, [session]);
  return <FaultContext.Provider value={privacyMode ? null : play}>
    <div className="fault-host" inert={session ? true : undefined}>{children}</div>
    {session && !privacyMode && createPortal(<FaultOverlay key={session.id} scope={session.scope} onClose={close} />, document.body)}
  </FaultContext.Provider>;
}

/** Starts a session, or null where the game must not be offered (privacy mode, no host). */
export function useFaultGame(): Play | null {
  return useContext(FaultContext);
}

function FaultOverlay({ scope, onClose }: { scope: FaultScope; onClose: () => void }) {
  const frame = useRef<HTMLIFrameElement>(null);
  const [state, setState] = useState<"loading" | "playing" | "empty" | "failed">("loading");
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    const controller = new AbortController();
    const link = connectFaultFrame({ game: () => frame.current?.contentWindow ?? null, onClose: () => close.current() });
    void scope(controller.signal).then(async (items) => {
      const images = faultAssets(items);
      if (!images.length) return "empty" as const;
      const photos = await loadFaultPhotos(images, controller.signal);
      if (!photos.length) return "failed" as const;
      link.supply(photos);
      return "playing" as const;
    }).then((next) => { if (!controller.signal.aborted) setState(next); },
      () => { if (!controller.signal.aborted) setState("failed"); });
    return () => { controller.abort(); link.dispose(); };
  }, [scope]);
  useEffect(() => {
    // Keys pressed inside the game stay in its document (Esc pauses there). This only sees keys
    // while focus is on the host surface, and keeps them from closing or navigating the view beneath.
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopImmediatePropagation();
      close.current();
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, []);
  const focusGame = () => { frame.current?.focus(); frame.current?.contentWindow?.focus(); };
  return <div className="fault-overlay" role="dialog" aria-modal="true" aria-label="FAULT">
    <iframe ref={frame} className="fault-frame" src={faultGameUrl()} title="FAULT — REVEAL" allow="fullscreen; autoplay" onLoad={focusGame} />
    {state !== "playing" && <div className="fault-status" role={state === "loading" ? "status" : "alert"}>
      <p>{state === "loading" ? "사진을 준비하고 있습니다" : state === "empty" ? "플레이할 이미지가 없습니다" : "사진을 불러오지 못했습니다"}</p>
      <Button variant="ghost" onClick={() => close.current()}>닫기</Button>
    </div>}
  </div>;
}

export function GamepadIcon(props: SVGProps<SVGSVGElement>) {
  return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.25} strokeLinecap="square" strokeLinejoin="miter" {...props}>
    <path d="M2 8h20v10H2zM6 11v4M4 13h4M15 12h2M18 14h2M10 8V5h4v3" />
  </svg>;
}

/** The view-toolbar entry for a whole album, character or classification. */
export function FaultPlayButton({ scope }: { scope: FaultScope | null }) {
  const play = useFaultGame();
  if (!play || !scope) return null;
  return <Button size="icon" variant="ghost" aria-label="이 묶음으로 플레이" aria-description="이 묶음의 이미지 중 24장을 무작위로 골라 FAULT를 시작합니다" onClick={() => play(scope)}>
    <GamepadIcon aria-hidden="true" />
  </Button>;
}

/** The selection entry: exactly the selected still images (videos ignored), 1–24 of them. */
export function faultSelectionItem(play: Play | null, selected: readonly AssetSummary[]): ContextMenuItem[] {
  if (!play || !selected.length) return [];
  const images = faultAssets(selected);
  const hint = !images.length ? "이미지를 선택해 주세요" : images.length > FAULT_MAX_PHOTOS ? `${FAULT_MAX_PHOTOS}장까지 선택할 수 있습니다` : null;
  return [{ id: "fault", label: hint ? `▶ FAULT · ${hint}` : "▶ FAULT", disabled: hint !== null, onSelect: () => { if (!hint) play(() => Promise.resolve(images)); } }];
}

type ScopeQuery = Omit<AssetQuery, "sort" | "randomPivot" | "after" | "before" | "aroundDate" | "limit" | "mediaKind">;
/** One random-order page is a random window of the whole scope; 24 are drawn from it. */
const SCOPE_SAMPLE = 200;

function randomPivot() {
  return Array.from(crypto.getRandomValues(new Uint8Array(16)), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * The whole-scope entry for asset-query views, or null when the scope shows no still image
 * (`hasImages`: the loaded page shows one, or more pages remain to be read).
 */
export function useFaultQueryScope(gateway: Pick<LibraryGateway, "listAssets">, query: ScopeQuery | null, hasImages: boolean): FaultScope | null {
  const play = useFaultGame();
  const key = play && query && hasImages ? JSON.stringify(query) : null;
  return useMemo(() => {
    if (!key) return null;
    const scope = JSON.parse(key) as ScopeQuery;
    return () => gateway.listAssets({ ...scope, mediaKind: "images", sort: "random", randomPivot: randomPivot(), after: null, limit: SCOPE_SAMPLE }).then((page) => page.items);
  }, [gateway, key]);
}

/** Reads cursor pages until `max` assets (or the end); for views without a random-order query. */
export async function collectPages(page: (after: string | null) => Promise<{ items: AssetSummary[]; nextCursor: string | null }>, signal: AbortSignal, max = 2000): Promise<AssetSummary[]> {
  const items: AssetSummary[] = [];
  let after: string | null = null;
  do {
    if (signal.aborted) throw new DOMException("Cancelled", "AbortError");
    const next = await page(after);
    items.push(...next.items);
    after = next.nextCursor;
  } while (after && items.length < max);
  return items;
}
