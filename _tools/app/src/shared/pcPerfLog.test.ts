import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { invoke } from "@tauri-apps/api/core";
import { beginNativePhase, nativePerfEnabled } from "./nativePerf";
import { flushPcPerf, initPcPerfLog, pcFolderReady, pcFolderScope, pcHomeReady, pcNavigation, pcStartupMark, pcStartupRead, pcTabShown, pcViewerClosed, pcViewerOpened, resetPcPerfForTests } from "./pcPerfLog";

let observed: PerformanceObserverCallback;
let frames: Map<number, FrameRequestCallback>;
let sequence: number;
const ipc = (enabled: boolean) => vi.fn(async (command: string) => command === "perf_log_enabled" ? enabled : undefined);
const init = (send: ReturnType<typeof ipc>) => initPcPerfLog(send as unknown as typeof invoke);
const rows = (send: ReturnType<typeof ipc>) => send.mock.calls.flatMap(call => {
  const args = (call as unknown[])[1] as { lines?: string[] } | undefined;
  return args?.lines?.map(line => JSON.parse(line)) ?? [];
});
function paint() {
  for (let round = 0; round < 2; round++) {
    const current = [...frames.values()]; frames.clear();
    current.forEach(callback => callback(performance.now()));
  }
}
beforeEach(() => {
  vi.useFakeTimers(); frames = new Map(); sequence = 0;
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => { frames.set(++sequence, callback); return sequence; });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => frames.delete(id));
  vi.stubGlobal("PerformanceObserver", class {
    constructor(callback: PerformanceObserverCallback) { observed = callback; }
    observe = vi.fn(); disconnect = vi.fn(); takeRecords = () => [];
  });
});
afterEach(() => { resetPcPerfForTests(); document.body.innerHTML = ""; vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

it("disabled performs one startup IPC and never observes, times interactions or writes", async () => {
  const send = ipc(false), mark = vi.spyOn(performance, "mark");
  await init(send); await init(send);
  pcNavigation("home", "assets", "plain", "private/path"); pcStartupMark("homeDataReady");
  vi.advanceTimersByTime(3000); window.dispatchEvent(new Event("pagehide"));
  expect(send).toHaveBeenCalledTimes(1); expect(send).toHaveBeenCalledWith("perf_log_enabled");
  expect(mark).not.toHaveBeenCalled(); expect(nativePerfEnabled()).toBe(false);
});
it("startup read timing preserves replies and errors without recording their payloads", async () => {
  const send = ipc(true); await init(send);
  const value = { privatePath: "secret" };
  expect(await pcStartupRead("home.media", async () => value)).toBe(value);
  const error = new Error("private failure");
  await expect(pcStartupRead("home.media", async () => { throw error; })).rejects.toBe(error);
  flushPcPerf();
  expect(rows(send).filter(row => row.name === "home.media.reply").map(row => row.status)).toEqual(["ok", "error"]);
  expect(JSON.stringify(rows(send))).not.toContain("secret");
  expect(JSON.stringify(rows(send))).not.toContain("private failure");
});
it("batches only w4 measures once a second and flushes on pagehide", async () => {
  const send = ipc(true); await init(send);
  observed({ getEntries: () => [
    { name: "w4:collections.query.done", duration: 12, startTime: 3 },
    { name: "unrelated", duration: 1, startTime: 0 },
  ] } as unknown as PerformanceObserverEntryList, {} as PerformanceObserver);
  expect(send).toHaveBeenCalledTimes(1);
  vi.advanceTimersByTime(1000);
  expect(rows(send).filter(row => row.event === "measure")).toEqual([{ event: "measure", name: "w4:collections.query.done", durationMs: 12, startMs: 3 }]);
  pcStartupMark("splashEnd"); window.dispatchEvent(new Event("pagehide"));
  expect(rows(send).some(row => row.name === "splashEnd")).toBe(true);
});
it("superseded tabs and folders are cancelled, with no private scope in payloads", async () => {
  const send = ipc(true); await init(send);
  const scope = pcFolderScope({ kind: "classification", classificationId: "C:/private/folder", characterId: "private-asset-id" });
  pcNavigation("home", "assets", "character", scope);
  pcTabShown("assets");
  pcNavigation("assets", "manga"); paint(); pcTabShown("manga"); paint(); flushPcPerf();
  const interactions = rows(send).filter(row => row.event === "interaction" && row.name !== "startup");
  expect(interactions.map(row => [row.name, row.label, row.status])).toEqual([
    ["tab.switch", "assets", "cancelled"], ["library.folder-switch", "character", "cancelled"], ["tab.switch", "manga", "ok"],
  ]);
  const payload = JSON.stringify(rows(send));
  expect(payload).not.toContain("private"); expect(payload).not.toContain("classificationId"); expect(payload).not.toContain("https:");
});
it("cover-heavy bursts are split into bounded native batches", async () => {
  const send = ipc(true); await init(send);
  const entries = Array.from({ length: 600 }, () => ({ name: "w4:collections.query.done", duration: 1, startTime: 0 }));
  observed({ getEntries: () => entries } as unknown as PerformanceObserverEntryList, {} as PerformanceObserver);
  flushPcPerf();
  expect(rows(send).filter(row => row.event === "measure")).toHaveLength(600);
  const batches = send.mock.calls.slice(1).map(call => ((call as unknown[])[1] as { lines: string[] }).lines);
  expect(batches).toHaveLength(3);
  expect(batches.every(batch => batch.length <= 256)).toBe(true);
});
it("collections wait for both existing visible cover phase and shown destination, then label warm", async () => {
  const send = ipc(true); await init(send);
  pcNavigation("home", "collections", undefined, undefined, true);
  const phase = beginNativePhase("collections.list-to-first-cover")!;
  phase.mark("list-committed"); phase.mark("visible"); paint(); flushPcPerf();
  expect(rows(send).some(row => row.event === "interaction" && row.name === "collections.open")).toBe(false);
  pcTabShown("collections"); paint(); flushPcPerf();
  pcNavigation("collections", "home"); pcNavigation("home", "collections", undefined, undefined, true);
  window.dispatchEvent(new Event("pagehide"));
  expect(rows(send).filter(row => row.name === "collections.open").map(row => [row.label, row.status])).toEqual([["first", "ok"], ["warm", "cancelled"]]);
  phase.cancel();
});
it("only matching committed folder can finish and empty viewport completes after paint", async () => {
  const send = ipc(true); await init(send);
  const host = document.createElement("div"); document.body.append(host);
  pcNavigation("assets", "assets", "plain", "new-private-scope");
  expect(pcFolderReady("old-private-scope", host, () => 0)).toBeUndefined();
  pcFolderReady("new-private-scope", host, () => 0); paint(); paint(); flushPcPerf();
  expect(rows(send).filter(row => row.event === "interaction")).toMatchObject([{ name: "library.folder-switch", status: "ok", tileCount: 0 }]);
});
it("a cover phase from an outgoing collection cannot complete a newer open", async () => {
  const send = ipc(true); await init(send);
  const outgoing = beginNativePhase("collections.list-to-first-cover")!;
  vi.advanceTimersByTime(1);
  pcNavigation("home", "collections", undefined, undefined, true);
  pcTabShown("collections"); outgoing.mark("visible"); paint(); flushPcPerf();
  expect(rows(send).some(row => row.name === "collections.open")).toBe(false);
  pcNavigation("collections", "home"); flushPcPerf();
  expect(rows(send).filter(row => row.name === "collections.open")).toMatchObject([{ status: "cancelled" }]);
  outgoing.cancel();
});
it("startup keeps an early React milestone while check is in flight, without delaying it", async () => {
  let resolve!: (value: boolean) => void;
  const send = vi.fn(() => new Promise<boolean>(done => { resolve = done; }));
  const checking = initPcPerfLog(send as unknown as typeof invoke);
  pcStartupMark("firstReactRender"); resolve(true); await checking;
  const home = document.createElement("div"); document.body.append(home);
  pcHomeReady(home); pcStartupMark("splashEnd"); paint(); paint(); flushPcPerf();
  expect(rows(send as unknown as ReturnType<typeof ipc>).filter(row => row.event === "startup").map(row => row.name)).toContain("homeFullyShown");
});
it("folder waits for actual decoding and never promotes lazy loading", async () => {
  const send = ipc(true); await init(send);
  const host = document.createElement("div"), image = document.createElement("img");
  image.src = "https://private.example/private-asset.jpg"; image.loading = "lazy";
  host.append(image); document.body.append(host);
  const rect = { width: 40, height: 40, top: 0, bottom: 40, left: 0, right: 40, x: 0, y: 0, toJSON() {} };
  vi.spyOn(host, "getBoundingClientRect").mockReturnValue(rect);
  vi.spyOn(image, "getBoundingClientRect").mockReturnValue(rect);
  Object.defineProperties(image, { complete: { value: true }, naturalWidth: { value: 40 } });
  let decoded!: () => void;
  image.decode = vi.fn(() => new Promise<void>(resolve => { decoded = resolve; }));
  pcNavigation("assets", "assets", "plain", "private-folder");
  pcFolderReady("private-folder", host, () => 1); paint();
  await Promise.resolve(); flushPcPerf();
  expect(rows(send).filter(row => row.event === "interaction")).toHaveLength(0);
  expect(image.loading).toBe("lazy"); expect(image.decode).toHaveBeenCalledOnce();
  decoded(); await vi.advanceTimersByTimeAsync(0); paint(); paint(); flushPcPerf();
  expect(rows(send).filter(row => row.event === "interaction")).toMatchObject([{ name: "library.folder-switch", tileCount: 1, status: "ok" }]);
  expect(JSON.stringify(rows(send))).not.toContain("private");
});
it("startup samples images at splash reveal rather than an early empty data commit", async () => {
  const send = ipc(true); await init(send);
  const host = document.createElement("div"); document.body.append(host);
  const bounds = vi.spyOn(host, "getBoundingClientRect");
  pcHomeReady(host); paint(); flushPcPerf();
  expect(bounds).not.toHaveBeenCalled();
  expect(rows(send).some(row => row.name === "homeViewportImagesReady")).toBe(false);
  pcStartupMark("splashLeaving"); paint(); flushPcPerf();
  expect(rows(send).some(row => row.name === "homeViewportImagesReady")).toBe(true);
  expect(rows(send).some(row => row.name === "homeFullyShown")).toBe(false);
  pcStartupMark("splashEnd"); paint(); flushPcPerf();
  expect(rows(send).some(row => row.name === "homeFullyShown")).toBe(true);
});
it("folder preparation in a hidden destination cannot report a fast success", async () => {
  const send = ipc(true); await init(send);
  const host = document.createElement("div"); host.setAttribute("aria-hidden", "true"); document.body.append(host);
  pcNavigation("assets", "assets", "plain", "pending-folder");
  pcFolderReady("pending-folder", host, () => 0); paint(); paint(); flushPcPerf();
  expect(rows(send).filter(row => row.event === "interaction")).toHaveLength(0);
  pcNavigation("assets", "home"); host.removeAttribute("aria-hidden"); paint(); flushPcPerf();
  expect(rows(send).filter(row => row.name === "library.folder-switch")).toMatchObject([{ status: "cancelled" }]);
});
it("IPC and observer failures do not escape", async () => {
  await expect(initPcPerfLog(vi.fn().mockRejectedValue(new Error("no IPC")))).resolves.toBeUndefined();
  resetPcPerfForTests();
  vi.stubGlobal("PerformanceObserver", class { constructor() { throw new Error("unavailable"); } });
  await expect(init(ipc(true))).resolves.toBeUndefined();
  expect(() => pcNavigation("home", "assets")).not.toThrow();
});
const rect = { width: 40, height: 40, top: 0, bottom: 40, left: 0, right: 40, x: 0, y: 0, toJSON() {} };
const interactions = (send: ReturnType<typeof ipc>, name: string) => rows(send).filter(row => row.event === "interaction" && row.name === name);
it("viewer open runs from the tile click to the thumbnail, the decoded image and the painted image", async () => {
  const send = ipc(true); await init(send);
  const tile = document.createElement("div"); tile.dataset.assetId = "private-id"; document.body.append(tile);
  tile.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
  vi.advanceTimersByTime(40);
  pcViewerOpened();
  const preview = document.createElement("img"); preview.dataset.viewerZoomPreview = "true"; document.body.append(preview);
  const request = beginNativePhase("viewer.request")!;
  request.afterPaint("mounted-paint"); paint();
  vi.advanceTimersByTime(60);
  beginNativePhase("viewer.decode")!.mark("done");
  vi.advanceTimersByTime(30);
  request.mark("visible"); flushPcPerf();
  expect(interactions(send, "viewer.open").map(row => [row.label, row.status, row.durationMs])).toEqual([
    ["first-visible", "ok", 40], ["full-res-decoded", "ok", 100], ["full-res-visible", "ok", 130],
  ]);
  expect(JSON.stringify(rows(send))).not.toContain("private-id");
});
it("viewer open without a zoom preview counts the full image as the first picture, and closing early cancels the rest", async () => {
  const send = ipc(true); await init(send);
  pcViewerOpened();
  beginNativePhase("viewer.request")!.afterPaint("mounted-paint"); paint();
  expect(interactions(send, "viewer.open")).toHaveLength(0);
  pcViewerClosed(); flushPcPerf();
  expect(interactions(send, "viewer.open").map(row => [row.label, row.status])).toEqual([
    ["first-visible", "cancelled"], ["full-res-decoded", "cancelled"], ["full-res-visible", "cancelled"],
  ]);
  pcViewerOpened();
  const request = beginNativePhase("viewer.request")!;
  request.mark("visible"); flushPcPerf();
  expect(interactions(send, "viewer.open").slice(3).map(row => [row.label, row.status])).toEqual([["first-visible", "ok"], ["full-res-visible", "ok"]]);
});
it("disabled logging adds no intent listeners and viewer hooks do nothing", async () => {
  const add = vi.spyOn(document, "addEventListener");
  const send = ipc(false); await init(send);
  pcViewerOpened(); pcViewerClosed();
  expect(add).not.toHaveBeenCalledWith("dblclick", expect.anything(), true);
  expect(send).toHaveBeenCalledTimes(1);
});
it("opening a work inside Collections ends when the work screen is shown, and is cancelled by leaving", async () => {
  const send = ipc(true); await init(send);
  pcNavigation("collections", "collections", undefined, undefined, false, true);
  paint(); flushPcPerf();
  expect(interactions(send, "collections.work")).toHaveLength(0);
  pcTabShown("collection-work"); paint(); flushPcPerf();
  expect(interactions(send, "collections.work")).toMatchObject([{ label: "open", status: "ok" }]);
  pcNavigation("collections", "collections", undefined, undefined, false, true);
  pcNavigation("collections", "home"); flushPcPerf();
  expect(interactions(send, "collections.work").map(row => row.status)).toEqual(["ok", "cancelled"]);
});
it("warm Collections re-entry completes from covers that are already decoded", async () => {
  const send = ipc(true); await init(send);
  const host = document.createElement("div"); host.dataset.motionView = "collections";
  const cover = document.createElement("div"); cover.className = "collection-card__cover";
  const image = document.createElement("img"); image.src = "https://private.example/cover.jpg";
  cover.append(image); host.append(cover); document.body.append(host);
  vi.spyOn(host, "getBoundingClientRect").mockReturnValue(rect); vi.spyOn(image, "getBoundingClientRect").mockReturnValue(rect);
  Object.defineProperties(image, { complete: { value: true }, naturalWidth: { value: 40 } });
  image.decode = vi.fn(async () => undefined);
  pcNavigation("home", "collections", undefined, undefined, true);
  pcTabShown("collections"); paint();
  await vi.advanceTimersByTimeAsync(0); paint(); paint(); flushPcPerf();
  expect(image.decode).toHaveBeenCalledOnce();
  expect(interactions(send, "collections.open")).toMatchObject([{ label: "first", status: "ok" }]);
});
it("warm Collections re-entry does not complete from an empty list or an undecoded cover", async () => {
  const send = ipc(true); await init(send);
  const host = document.createElement("div"); host.dataset.motionView = "collections"; document.body.append(host);
  pcNavigation("home", "collections", undefined, undefined, true);
  pcTabShown("collections"); paint(); paint(); flushPcPerf();
  expect(interactions(send, "collections.open")).toHaveLength(0);
  const cover = document.createElement("div"); cover.className = "collection-card__cover";
  const image = document.createElement("img"); image.src = "https://private.example/cover.jpg"; cover.append(image); host.append(cover);
  vi.spyOn(host, "getBoundingClientRect").mockReturnValue(rect); vi.spyOn(image, "getBoundingClientRect").mockReturnValue(rect);
  await vi.advanceTimersByTimeAsync(0); paint(); paint(); flushPcPerf();
  expect(interactions(send, "collections.open")).toHaveLength(0);
  pcNavigation("collections", "home"); flushPcPerf();
  expect(interactions(send, "collections.open")).toMatchObject([{ status: "cancelled" }]);
});
