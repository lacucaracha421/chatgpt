import { invoke } from "@tauri-apps/api/core";
import { beginNativePhase, configurePcPerf } from "./nativePerf";
import { viewportImages, viewportImageDecoded } from "./motion/viewportImages";

export type Tab = "home" | "assets" | "collections" | "manga" | "notes" | "exchange" | "private_vault" | "manage";
export type FolderKind = "series" | "plain" | "character" | "album" | "other";
type Milestone = "firstReactRender" | "homeDataReady" | "homeViewportImagesReady" | "splashLeaving" | "splashEnd" | "homeFullyShown";
type ViewerStage = "first-visible" | "full-res-decoded" | "full-res-visible";
const VIEWER_STAGES: readonly ViewerStage[] = ["first-visible", "full-res-decoded", "full-res-visible"];
type Interaction = { name: string; startMs: number; phase: ReturnType<typeof beginNativePhase>; label: Tab | FolderKind | "first" | "warm" | "open"; scope?: string; done: boolean; stop?: () => void };
type ViewerOpen = { startMs: number; emitted: Set<ViewerStage>; done: boolean };
let enabled = false, initialized = false, firstCollection = true;
let pendingCheck = false;
let queue: string[] = [];
let tab: Interaction | undefined, folder: Interaction | undefined, collection: Interaction | undefined, work: Interaction | undefined;
let viewer: ViewerOpen | undefined;
let viewerIntent: { startMs: number; used: boolean } | undefined;
let warmCoverStop: (() => void) | undefined;
const milestones = new Map<Milestone, number>();
let startup: ReturnType<typeof beginNativePhase>;
let timer: ReturnType<typeof setInterval> | undefined;
let observer: PerformanceObserver | undefined;
let pendingHome: HTMLElement | null | undefined;
let startupFinishing = false;
let startupCancelled = false;
let collectionShown = false, coverReady = false;
let startupImagesStop: (() => void) | undefined;
let send: typeof invoke = invoke;
const MAX_BATCH = 256;
const MAX_QUEUED = 4096;
const safely = (task: () => void) => { try { task(); } catch { /* Measurement cannot fail application work. */ } };
const enqueue = (value: object) => { if (enabled && queue.length < MAX_QUEUED) safely(() => queue.push(JSON.stringify(value))); };
export const pcPerfEnabled = () => enabled;
/** Aggregate startup reads only; never serialize arguments, results or media addresses. */
export function pcStartupEvent(name: string, fields: Record<string, number | string | boolean> = {}) {
  if (enabled && performance.now() < 15000) enqueue({ event: "startup-detail", name, startMs: performance.now(), ...fields });
}
export async function pcStartupRead<T>(name: string, read: () => Promise<T>): Promise<T> {
  const startMs = performance.now();
  pcStartupEvent(`${name}.issued`);
  try {
    const value = await read();
    pcStartupEvent(`${name}.reply`, { durationMs: performance.now() - startMs, status: "ok" });
    return value;
  } catch (error) {
    pcStartupEvent(`${name}.reply`, { durationMs: performance.now() - startMs, status: "error" });
    throw error;
  }
}
export function flushPcPerf() {
  if (!enabled) return;
  safely(() => {
    collectMeasures(observer?.takeRecords() ?? []);
    const lines = queue; queue = [];
    for (let index = 0; index < lines.length; index += MAX_BATCH) {
      void send("perf_log_append", { lines: lines.slice(index, index + MAX_BATCH) }).catch(() => {});
    }
  });
}
function collectMeasures(entries: readonly PerformanceEntry[]) {
  for (const entry of entries) {
    if (!entry.name.startsWith("w4:")) continue;
    enqueue({ event: "measure", name: entry.name, durationMs: entry.duration, startMs: entry.startTime });
    // Only our opt-in session owns these entries. The Linux kit retains its entries.
    if (!(window as Window & { __nativeCheckPerf?: unknown }).__nativeCheckPerf) safely(() => performance.clearMeasures(entry.name));
  }
}
function end(interaction: Interaction | undefined, status: "ok" | "cancelled", tileCount?: number) {
  if (!interaction || interaction.done) return;
  interaction.done = true;
  interaction.stop?.();
  if (interaction === collection) { warmCoverStop?.(); warmCoverStop = undefined; }
  const endMs = performance.now();
  enqueue({ event: "interaction", name: interaction.name, label: interaction.label, status, startMs: interaction.startMs, durationMs: endMs - interaction.startMs, ...(tileCount === undefined ? {} : { tileCount }) });
  interaction.phase?.cancel();
}
function interaction(name: string, label: Interaction["label"], scope?: string): Interaction {
  return { name, label, scope, startMs: performance.now(), phase: beginNativePhase(name), done: false };
}
function cancelStartup() {
  if (milestones.has("homeFullyShown") || startupCancelled) return;
  startupCancelled = true; startupImagesStop?.(); startup?.cancel();
  enqueue({ event: "interaction", name: "startup", label: "home", status: "cancelled", startMs: 0, durationMs: performance.now() });
}
/** scope is an in-memory stale-result guard; never serialized. */
export function pcNavigation(from: Tab, to: Tab, folderKind?: FolderKind, scope?: string, collectionsOpen = false, workOpen = false) {
  if (!enabled) return;
  safely(() => {
    end(tab, "cancelled"); end(folder, "cancelled"); end(collection, "cancelled"); end(work, "cancelled");
    if (from === "home" && to !== "home") cancelStartup();
    collectionShown = from === to; coverReady = false;
    tab = from !== to ? interaction("tab.switch", to) : undefined;
    folder = folderKind ? interaction("library.folder-switch", folderKind, scope) : undefined;
    collection = collectionsOpen ? interaction("collections.open", firstCollection ? "first" : "warm") : undefined;
    if (collectionsOpen) firstCollection = false;
    work = workOpen ? interaction("collections.work", "open") : undefined;
  });
}
export function pcTabShown(destination: string) {
  if (!enabled) return;
  if (destination === "collection-work") {
    if (work && !work.done) safely(() => { const current = work!; current.phase?.mark("committed"); current.stop = current.phase?.afterPaint("ready"); });
    destination = "collections";
  }
  if (destination === "collections") { collectionShown = true; finishCollection(); watchWarmCovers(); }
  if (!tab || tab.label !== destination || tab.done) return;
  safely(() => {
    const current = tab!;
    current.phase?.mark("committed");
    const stop = current.phase?.afterPaint("ready");
    current.stop = stop;
  });
}
const COVER_SELECTOR = ".cs-front img, .collection-card__cover img:not(.physical-cover__shell)";
/**
 * Warm re-entry: covers that are already decoded raise no load event, so the kit's cover phase can
 * stay silent. Once the destination is shown, accept their decoded state.
 */
function watchWarmCovers() {
  if (!collection || collection.done || coverReady || warmCoverStop) return;
  const host = document.querySelector<HTMLElement>('[data-motion-view="collections"]');
  if (!host) return;
  const current = collection;
  const stop = observeImages(host, count => {
    warmCoverStop = undefined;
    if (count > 0 && collection === current && !current.done) { coverReady = true; finishCollection(); }
  }, true);
  warmCoverStop = stop;
}
/** Observes existing loads. Never promotes lazy images or starts a fetch. */
function observeImages(host: HTMLElement, ready: (count: number) => void, covers = false) {
  let stopped = false, frame = 0, scheduled = false;
  const decoding = new WeakSet<HTMLImageElement>();
  const decoded = new WeakMap<HTMLImageElement, string>();
  const source = (image: HTMLImageElement) => `${image.src}|${image.srcset}`;
  const check = () => safely(() => {
    if (stopped) return;
    // Prepared destinations can have geometry while the outgoing screen still owns paint.
    // Wait without sampling image layout while that existing gate is closed.
    if (!host.isConnected || host.closest('[inert], [aria-hidden="true"], [style*="visibility: hidden"], [style*="display: none"]')) {
      schedule(); return;
    }
    // covers: ready once one visible cover is decoded (warm re-entry); an empty or failed list never is.
    const images = covers ? viewportImages(host).filter(image => image.matches(COVER_SELECTOR)) : viewportImages(host);
    for (const image of images) {
      if (viewportImageDecoded(image)) decoded.set(image, source(image));
      if (decoded.get(image) === source(image) || decoding.has(image) || !image.complete || !image.naturalWidth) continue;
      const src = source(image);
      decoding.add(image);
      void Promise.resolve().then(() => image.decode?.()).then(() => {
        decoding.delete(image);
        if (!stopped && source(image) === src) decoded.set(image, src);
        schedule();
      }, () => { decoding.delete(image); });
    }
    if (covers ? images.some(image => decoded.get(image) === source(image)) : images.every(image => decoded.get(image) === source(image))) {
      stop();
      ready(images.length);
    }
  });
  const schedule = () => safely(() => {
    if (stopped || scheduled) return;
    scheduled = true;
    frame = requestAnimationFrame(() => { scheduled = false; check(); });
  });
  const mutations = new MutationObserver(schedule);
  const stop = () => { stopped = true; cancelAnimationFrame(frame); mutations.disconnect(); host.removeEventListener("load", schedule, true); };
  mutations.observe(host, { subtree: true, childList: true, attributes: true, attributeFilter: ["src", "srcset"] });
  host.addEventListener("load", schedule, true);
  schedule();
  return stop;
}
export function pcFolderReady(scope: string, host: HTMLElement | null, tileCount: () => number, kind?: FolderKind) {
  if (!enabled || !host || !folder || folder.done || folder.scope !== scope) return;
  let stop: (() => void) | undefined;
  safely(() => {
    const current = folder!;
    if (kind) current.label = kind;
    current.phase?.mark("committed");
    stop = observeImages(host, () => {
      if (current.done || current !== folder) return;
      current.stop = current.phase?.afterPaint("ready");
      // Count is retained only for this interaction, not in any media payload.
      folderTileCount = tileCount();
    });
    current.stop = stop;
  });
  return () => safely(() => { stop?.(); if (folder?.scope === scope) folder.stop?.(); });
}
let folderTileCount = 0;
/** Normalized only for stale-result identity; IDs never enter the output. */
export function pcFolderScope(view: { kind: string; classificationId?: string | null; characterId?: string; characterGroupId?: string; albumId?: string }) {
  return JSON.stringify([view.kind, view.classificationId ?? null, view.characterId ?? null, view.characterGroupId ?? null, view.albumId ?? null]);
}
function phaseCompleted(name: string, phase: string, phaseStartMs: number) {
  safely(() => {
    if (name === "startup" && phase === "ready") pcStartupMark("homeFullyShown");
    if (name === "collections.open" && phase === "ready") end(collection, "ok");
    if (name === "tab.switch" && phase === "ready") end(tab, "ok");
    if (name === "library.folder-switch" && phase === "ready") end(folder, "ok", folderTileCount);
    if (name === "collections.work" && phase === "ready") end(work, "ok");
    if (name === "viewer.decode" && phase === "done") viewerStage("full-res-decoded");
    if (name === "viewer.request") {
      // The zoom preview is the thumbnail already on screen; without one, the full image is the first picture.
      if (phase === "mounted-paint" && document.querySelector("[data-viewer-zoom-preview]")) viewerStage("first-visible");
      if (phase === "visible") { viewerStage("first-visible"); viewerStage("full-res-visible"); }
    }
    if (name === "collections.list-to-first-cover" && collection && !collection.done && phaseStartMs >= collection.startMs) {
      if (phase === "list-committed") collection.phase?.mark("list-committed");
      if (phase === "visible") { coverReady = true; finishCollection(); }
    }
  });
}
function finishCollection() {
  if (collection && !collection.done && collectionShown && coverReady) collection.stop = collection.phase?.afterPaint("ready");
}
function viewerStage(stage: ViewerStage) {
  if (!viewer || viewer.done || viewer.emitted.has(stage)) return;
  viewer.emitted.add(stage);
  enqueue({ event: "interaction", name: "viewer.open", label: stage, status: "ok", startMs: viewer.startMs, durationMs: performance.now() - viewer.startMs });
  if (stage === "full-res-visible") viewer.done = true;
}
function endViewer() {
  const current = viewer;
  viewer = undefined;
  if (!current || current.done) return;
  current.done = true;
  const durationMs = performance.now() - current.startMs;
  for (const stage of VIEWER_STAGES) {
    if (!current.emitted.has(stage)) enqueue({ event: "interaction", name: "viewer.open", label: stage, status: "cancelled", startMs: current.startMs, durationMs });
  }
}
/** The viewer just mounted. Its start is the last tile click/Enter within 2 s, else now. */
export function pcViewerOpened() {
  if (!enabled) return;
  safely(() => {
    endViewer();
    const now = performance.now();
    const intent = viewerIntent && !viewerIntent.used && now - viewerIntent.startMs < 2000 ? viewerIntent : undefined;
    if (viewerIntent) viewerIntent.used = true;
    viewer = { startMs: intent?.startMs ?? now, emitted: new Set(), done: false };
  });
}
export function pcViewerClosed() {
  if (enabled) safely(endViewer);
}
const INTENT_TARGET = "[data-asset-id], .asset-gallery__scroll [role='option']";
const INTENT_EVENTS = ["click", "dblclick", "keydown"] as const;
function onViewerIntent(event: Event) {
  safely(() => {
    if (event.type === "keydown" && (event as KeyboardEvent).key !== "Enter") return;
    const target = event.target;
    if (!(target instanceof Element) || target.closest(".asset-viewer, .viewer") || !target.closest(INTENT_TARGET)) return;
    viewerIntent = { startMs: performance.now(), used: false };
  });
}
/** First time a named startup input becomes ready (e.g. one Home gate). Opt-in log only. */
const seenInputs = new Set<string>();
export function pcStartupInput(name: string) {
  if (!enabled || seenInputs.has(name)) return;
  seenInputs.add(name);
  enqueue({ event: "startup-input", name, startMs: performance.now() });
}
export function pcStartupMark(name: Milestone) {
  if ((!enabled && !pendingCheck) || milestones.has(name)) return;
  if (startupCancelled && (name === "homeViewportImagesReady" || name === "homeFullyShown")) return;
  safely(() => {
    const at = performance.now(); milestones.set(name, at);
    if (enabled) {
      startup?.mark(name); enqueue({ event: "startup", name, startMs: at, timeOrigin: performance.timeOrigin });
      if (name === "splashLeaving" || name === "splashEnd") observeStartupImages();
      if (!startupFinishing && milestones.has("homeDataReady") && milestones.has("homeViewportImagesReady") && milestones.has("splashEnd")) {
        startupFinishing = true; startup?.afterPaint("ready");
      }
    }
  });
}
function observeStartupImages() {
  // The splash's existing quiet window owns late src assignment. Sample its reveal,
  // rather than mistaking an early data commit with no image addresses for readiness.
  if (pendingHome && !startupCancelled && !milestones.has("homeViewportImagesReady") && !startupImagesStop
    && (milestones.has("splashLeaving") || milestones.has("splashEnd"))) {
    startupImagesStop = observeImages(pendingHome, () => pcStartupMark("homeViewportImagesReady"));
  }
}
export function pcHomeReady(host?: HTMLElement | null) {
  if (pendingCheck && !enabled) { pcStartupMark("homeDataReady"); pendingHome = host; return; }
  if (!enabled || startupCancelled) return;
  safely(() => {
    pcStartupMark("homeDataReady");
    pendingHome = host;
    observeStartupImages();
  });
}
function pagehide() {
  safely(() => { end(tab, "cancelled"); end(folder, "cancelled"); end(collection, "cancelled"); end(work, "cancelled"); endViewer(); cancelStartup(); flushPcPerf(); });
}
/** One startup check, concurrent with React. Nothing waits for logging. */
export async function initPcPerfLog(ipc: typeof invoke = invoke) {
  if (initialized) return;
  initialized = true; pendingCheck = true; send = ipc;
  try {
    if (!(await ipc<boolean>("perf_log_enabled"))) return;
    enabled = true;
    configurePcPerf(true, phaseCompleted);
    startup = beginNativePhase("startup", 0);
    observer = new PerformanceObserver(list => safely(() => collectMeasures(list.getEntries())));
    observer.observe({ type: "measure", buffered: true });
    enqueue({ event: "clock", timeOrigin: performance.timeOrigin, startMs: performance.now(), unixMs: Date.now() });
    for (const [name, startMs] of milestones) {
      enqueue({ event: "startup", name, startMs, timeOrigin: performance.timeOrigin });
      safely(() => performance.measure(`w4:startup.${name}`, { start: 0, end: startMs }));
    }
    if (pendingHome !== undefined) pcHomeReady(pendingHome);
    timer = setInterval(flushPcPerf, 1000);
    window.addEventListener("pagehide", pagehide);
    for (const type of INTENT_EVENTS) document.addEventListener(type, onViewerIntent, true);
  } catch {
    enabled = false; configurePcPerf(false); queue = [];
    safely(() => observer?.disconnect());
  }
  finally { pendingCheck = false; if (!enabled) { milestones.clear(); pendingHome = undefined; } }
}
export function resetPcPerfForTests() {
  if (timer) clearInterval(timer);
  observer?.disconnect(); startupImagesStop?.();
  window.removeEventListener("pagehide", pagehide);
  for (const type of INTENT_EVENTS) document.removeEventListener(type, onViewerIntent, true);
  end(tab, "cancelled"); end(folder, "cancelled"); end(collection, "cancelled"); end(work, "cancelled"); warmCoverStop?.(); startup?.cancel();
  enabled = false; initialized = false; pendingCheck = false; firstCollection = true;
  queue = []; tab = folder = collection = work = undefined; viewer = viewerIntent = undefined; warmCoverStop = undefined; observer = undefined; startupImagesStop = undefined; milestones.clear(); seenInputs.clear(); pendingHome = undefined; startupFinishing = false; startupCancelled = false;
  configurePcPerf(false);
}
