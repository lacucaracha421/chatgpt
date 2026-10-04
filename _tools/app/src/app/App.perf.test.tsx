// PERF-ALL-001: render/commit harness for the desktop React app.
// The measurement suite runs only with LAKOMICS_PERF=1 (it prints one `PERF <label> <json>` line
// per measurement and asserts no thresholds), from _tools/app/:
//   LAKOMICS_PERF=1 npx vitest run src/app/App.perf.test.tsx --reporter=verbose --silent=false
// The idle gate at the end always runs: its thresholds only tighten (docs/agents/implementation.md,
// "Performance work"). Raise one only with a measured, justified reason.
// Method: the whole App sits under one React <Profiler>; `commits` counts its onRender
// callbacks (one per React commit that touched the tree). Selected components are wrapped
// through vi.mock so their render-function calls are counted. Thumbnail URL helper calls
// are counted separately (not exact tile renders). Status reads return fresh objects, like real IPC.
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { Profiler, type ProfilerOnRenderCallback } from "react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { DropSubscriber } from "../ingestion/useFileDrop";
import { gatewayCalls, perfGateway, resetCalls } from "../test/perfGateway";
import { App } from "./App";

const RUN = process.env.LAKOMICS_PERF === "1";
// LAKOMICS_PERF_QUIET=1: background status reads return stable objects, so an interaction's
// numbers exclude the idle re-renders measured separately by the idle tests.
const QUIET = process.env.LAKOMICS_PERF_QUIET === "1";
const gw = () => perfGateway(QUIET ? { stableVault: true, stableProgress: true } : {});

const probe = vi.hoisted(() => {
  const renders: Record<string, number> = {};
  const invokes: Record<string, number> = {};
  const state = { commits: 0, actualMs: 0, stableCharacterStatus: false };
  const count = (name: string) => { renders[name] = (renders[name] ?? 0) + 1; };
  const reset = () => {
    for (const key of Object.keys(renders)) delete renders[key];
    for (const key of Object.keys(invokes)) delete invokes[key];
    state.commits = 0; state.actualMs = 0;
  };
  const characterStatus = {
    running: true, workActive: false, paused: false, completed: 0, confirmed: 0, historyRefreshActive: false,
    persistentError: null, activeWork: null, historyRefreshes: [] as unknown[],
  };
  return { renders, invokes, state, count, reset, characterStatus };
});

const wrapExports = vi.hoisted(() => async (mod: Record<string, unknown>, keys: string[]) => {
  const { createElement } = await import("react");
  const out: Record<string, unknown> = { ...mod };
  for (const key of keys) {
    const Component = mod[key] as Parameters<typeof createElement>[0];
    const Wrapped = (props: object) => { probe.count(key); return createElement(Component, props); };
    Wrapped.displayName = `Counted(${key})`;
    out[key] = Wrapped;
  }
  return out;
});

vi.mock("../assets/AssetBrowser", async (original) => wrapExports(await original(), ["AssetBrowser"]));
vi.mock("../assets/AssetGallery", async (original) => wrapExports(await original(), ["AssetGallery"]));
vi.mock("../assets/AssetViewer", async (original) => wrapExports(await original(), ["AssetViewer"]));
vi.mock("../assets/AssetToolbar", async (original) => wrapExports(await original(), ["AssetToolbar"]));
vi.mock("../classification/ClassificationSidebar", async (original) => wrapExports(await original(), ["ClassificationSidebar"]));
vi.mock("../layout/AppShell", async (original) => wrapExports(await original(), ["AppShell"]));
vi.mock("../layout/StatusCenter", async (original) => wrapExports(await original(), ["StatusCenter"]));
vi.mock("../layout/WorkspaceNavigation", async (original) => wrapExports(await original(), ["WorkspaceNavigation"]));
vi.mock("../collections/CollectionBrowser", async (original) => wrapExports(await original(), ["CollectionBrowser"]));
vi.mock("../notes/NotesView", async (original) => wrapExports(await original(), ["NotesView"]));
vi.mock("../assets/mediaUrl", async (original) => {
  const m = await original<typeof import("../assets/mediaUrl")>();
  return {
    ...m,
    thumbnailUrl: (...args: Parameters<typeof m.thumbnailUrl>) => { probe.count("thumbnailUrlCalls"); return m.thumbnailUrl(...args); },
    assetThumbnailUrl: (...args: Parameters<typeof m.assetThumbnailUrl>) => { probe.count("thumbnailUrlCalls"); return m.assetThumbnailUrl(...args); },
  };
});
vi.mock("../assets/masonryLayout", async (original) => {
  const m = await original<typeof import("../assets/masonryLayout")>();
  return { ...m, buildMasonryLayout: (...args: Parameters<typeof m.buildMasonryLayout>) => { probe.count("buildMasonryLayout"); return m.buildMasonryLayout(...args); } };
});

// Native events: capture `listen` handlers so a test can emit what the Rust side emits.
const nativeBus = vi.hoisted(() => {
  const handlers = new Map<string, Set<(event: { event: string; payload: unknown }) => void>>();
  const emit = (event: string, payload: unknown = null) => handlers.get(event)?.forEach(handler => handler({ event, payload }));
  return { handlers, emit };
});
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async (event: string, handler: (event: { event: string; payload: unknown }) => void) => {
    if (!nativeBus.handlers.has(event)) nativeBus.handlers.set(event, new Set());
    nativeBus.handlers.get(event)!.add(handler);
    return () => { nativeBus.handlers.get(event)?.delete(handler); };
  }),
  emit: vi.fn(),
}));

vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn() }));
const { nativeInvoke } = vi.hoisted(() => ({
  nativeInvoke: vi.fn(async (command: string, args?: { operation?: string; input?: Record<string, unknown> }) => {
    probe.invokes[command === "notes_request" ? `notes_request:${args?.operation}` : command] =
      (probe.invokes[command === "notes_request" ? `notes_request:${args?.operation}` : command] ?? 0) + 1;
    if (command === "notes_request") {
      const note = { id: "n", title: "Draft", body: "", pinned: false, deleted: false, createdAt: "2026-09-07T00:00:00Z", updatedAt: "2026-09-07T00:00:00Z", localRevision: 0, pending: false, conflict: false };
      if (args?.operation === "save") return { ...note, ...args.input, localRevision: Number(args.input?.expectedRevision ?? 0) + 1, pending: true };
      return { unlocked: true, notes: [note], lastSyncedAt: null };
    }
    // Fresh objects/arrays on every call, like a real IPC round-trip.
    if (command === "workload_profile") return { lightweight: false, autoEnterMinutes: null, closeToTray: true, restricted: false, hidden: false, trayAvailable: true };
    if (command === "character_incremental_status") return probe.state.stableCharacterStatus
      ? probe.characterStatus
      : { ...probe.characterStatus, historyRefreshes: [] };
    if (command === "exchange_snapshot") return (await import("../exchange/exchangeStore")).EMPTY_EXCHANGE;
    if (command === "list_character_targets" || command === "character_series") return [];
    if (command === "character_review_pending_map") return {};
    if (command === "browse_character_assets") return { items: [], nextCursor: null, totalCount: 0 };
    return undefined;
  }),
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: nativeInvoke, isTauri: () => false, convertFileSrc: (path: string) => path }));

const noDrops: DropSubscriber = async () => () => undefined;

type Snapshot = { commits: number; profilerActualMs: number; renders: Record<string, number>; gateway: Record<string, number>; invoke: Record<string, number> };

function snapshot(gateway: ReturnType<typeof perfGateway>): Snapshot {
  return {
    commits: probe.state.commits,
    profilerActualMs: Math.round(probe.state.actualMs),
    renders: { ...probe.renders },
    gateway: gatewayCalls(gateway),
    invoke: Object.fromEntries(Object.entries(probe.invokes).filter(([command]) => !command.startsWith("plugin:event"))),
  };
}

function report(label: string, value: Snapshot) {
  // One parseable line per measurement.
  console.log(`PERF ${label} ${JSON.stringify(value)}`);
}

async function advance(ms: number, step = 250) {
  for (let elapsed = 0; elapsed < ms; elapsed += step) {
    await act(async () => { await vi.advanceTimersByTimeAsync(Math.min(step, ms - elapsed)); });
  }
}

const onRender: ProfilerOnRenderCallback = (_id, _phase, actualDuration) => {
  probe.state.commits += 1;
  probe.state.actualMs += actualDuration;
};

function renderApp(gateway: ReturnType<typeof perfGateway>) {
  return render(
    <Profiler id="app" onRender={onRender}>
      <App gateway={gateway} selectFolder={vi.fn()} subscribeDrops={noDrops} />
    </Profiler>,
  );
}

/**
 * Start the app, open the library and let startup work settle (fake time). The app opens on
 * Home; the measurements and gates are about the Library grid, so enter 에셋 first.
 */
async function startWorkspace(gateway: ReturnType<typeof perfGateway>) {
  renderApp(gateway);
  await advance(5_000);
  expect(screen.getByRole("main", { name: "라이브러리 작업 공간" })).toBeInTheDocument();
  const rail = screen.getByRole("navigation", { name: "주요 영역" });
  await act(async () => { fireEvent.click(within(rail).getByRole("button", { name: "에셋" })); });
  await advance(2_000);
  expect(document.querySelector(".asset-gallery__scroll")).not.toBeNull();
}

// Shared by the measurement suite and the idle gate.
// Lazy views resolve through real module loading; warm them so fake time can drive them.
beforeAll(async () => {
  await Promise.all([import("../collections/CollectionBrowser"), import("../notes/NotesView"), import("../collections/CollectionOverlay"), import("../manga/MangaBrowser"), import("../home/HomeView")]);
});
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date", "requestAnimationFrame", "cancelAnimationFrame"] });
  vi.setSystemTime(new Date("2026-10-02T03:00:00Z"));
  localStorage.clear();
  localStorage.setItem("lakomics.libraryPath", "C:\\Lakomics");
  Object.defineProperty(window, "__TAURI_INTERNALS__", { configurable: true, value: { invoke: nativeInvoke } });
  Object.defineProperties(HTMLElement.prototype, {
    offsetWidth: { configurable: true, get: () => 1400 }, clientWidth: { configurable: true, get: () => 1200 },
    offsetHeight: { configurable: true, get: () => 900 }, clientHeight: { configurable: true, get: () => 900 },
    setPointerCapture: { configurable: true, value: vi.fn() },
  });
  vi.spyOn(document, "hasFocus").mockReturnValue(true);
  probe.reset();
  probe.state.stableCharacterStatus = QUIET;
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe.skipIf(!RUN)("desktop render/commit baseline (PERF-ALL-001)", () => {

  it("startup: open library to a settled Library grid", async () => {
    const gateway = gw();
    await startWorkspace(gateway);
    report("startup(fake7s)", snapshot(gateway));
  });

  it("idle: 60 s with the window visible and focused, nothing happening", async () => {
    const gateway = gw();
    await startWorkspace(gateway);
    await advance(30_000); // past every startup one-shot
    probe.reset(); resetCalls(gateway);
    await advance(60_000);
    report("idle(60s)", snapshot(gateway));
  });

  it("focus: one window focus event while idle", async () => {
    const gateway = gw();
    await startWorkspace(gateway);
    await advance(30_000);
    probe.reset(); resetCalls(gateway);
    await act(async () => { window.dispatchEvent(new Event("focus")); });
    await advance(2_000);
    report("focus(+2s)", snapshot(gateway));
  });

  it("idle attribution: which poller causes the idle commits", async () => {
    const variants: Array<[string, Parameters<typeof perfGateway>[0], boolean]> = [
      ["all-fresh", {}, false],
      ["vault-stable", { stableVault: true }, false],
      ["vault+character-stable", { stableVault: true }, true],
      ["vault+character+progress-stable", { stableVault: true, stableProgress: true }, true],
    ];
    for (const [label, options, stableCharacter] of variants) {
      probe.state.stableCharacterStatus = stableCharacter;
      const gateway = perfGateway(options);
      await startWorkspace(gateway);
      await advance(30_000);
      probe.reset(); resetCalls(gateway);
      await advance(60_000);
      report(`idle-attribution(60s,${label})`, snapshot(gateway));
      cleanup();
    }
    probe.state.stableCharacterStatus = QUIET;
  });

  it("hidden window: 60 s after the native side reports hidden", async () => {
    const gateway = gw();
    await startWorkspace(gateway);
    await advance(30_000);
    // workload://changed would carry hidden=true; the profile store only listens to native
    // events, so emulate its effect on document visibility and blur here.
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "hidden" });
    Object.defineProperty(document, "hidden", { configurable: true, get: () => true });
    await act(async () => { window.dispatchEvent(new Event("blur")); document.dispatchEvent(new Event("visibilitychange")); });
    probe.reset(); resetCalls(gateway);
    await advance(60_000);
    report("hidden-document(60s)", snapshot(gateway));
    delete (document as unknown as Record<string, unknown>).visibilityState;
    delete (document as unknown as Record<string, unknown>).hidden;
  });

  it("classification sidebar: select a folder until its grid settles", async () => {
    const gateway = gw();
    await startWorkspace(gateway);
    await advance(30_000);
    probe.reset(); resetCalls(gateway);
    await act(async () => { fireEvent.click(screen.getByRole("treeitem", { name: /게임/ })); });
    await advance(2_000);
    report("sidebar-select(+2s)", snapshot(gateway));
  });

  it("library grid: scroll deep enough to load the next page", async () => {
    const gateway = gw();
    await startWorkspace(gateway);
    await advance(30_000);
    const scroller = document.querySelector<HTMLElement>(".asset-gallery__scroll");
    expect(scroller).not.toBeNull();
    probe.reset(); resetCalls(gateway);
    const pages = [] as Snapshot[];
    for (let step = 1; step <= 3; step += 1) {
      await act(async () => { scroller!.scrollTop = step * 4_000; fireEvent.scroll(scroller!); });
      await advance(1_000);
      pages.push(snapshot(gateway));
    }
    report("grid-scroll(3 steps, cumulative)", pages[pages.length - 1]);
    report("grid-scroll(step1)", pages[0]);
  });

  it("viewer: open an asset, then next ×5, then close", async () => {
    const gateway = gw();
    await startWorkspace(gateway);
    await advance(30_000);
    const tile = screen.getAllByRole("option")[0];
    probe.reset(); resetCalls(gateway);
    await act(async () => { fireEvent.click(tile); fireEvent.doubleClick(tile); });
    await advance(1_000);
    report("viewer-open(+1s)", snapshot(gateway));
    const dialog = screen.getByRole("dialog");
    probe.reset(); resetCalls(gateway);
    await act(async () => { fireEvent.keyDown(dialog, { key: "ArrowRight" }); });
    await advance(1_000);
    report("viewer-next(1st,+1s)", snapshot(gateway));
    probe.reset(); resetCalls(gateway);
    for (let index = 0; index < 4; index += 1) {
      await act(async () => { fireEvent.keyDown(screen.getByRole("dialog"), { key: "ArrowRight" }); });
      await advance(200);
    }
    await advance(1_000);
    report("viewer-next(remaining4 cumulative)", snapshot(gateway));
    probe.reset(); resetCalls(gateway);
    await act(async () => { fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "감상 화면 닫기" })); });
    await advance(1_000);
    report("viewer-close(+1s)", snapshot(gateway));
  });

  it("collections: open the Collections tab (60 items) until it settles", async () => {
    const gateway = gw();
    await startWorkspace(gateway);
    await advance(30_000);
    probe.reset(); resetCalls(gateway);
    const rail = screen.getByRole("navigation", { name: "주요 영역" });
    await act(async () => { fireEvent.click(within(rail).getByRole("button", { name: "컬렉션" })); });
    await advance(3_000);
    expect(screen.getByRole("region", { name: "컬렉션" })).toBeInTheDocument();
    report("collections-open(+3s)", snapshot(gateway));
    probe.reset(); resetCalls(gateway);
    await advance(60_000);
    report("collections-idle(60s)", snapshot(gateway));
  });

  it("notes: open 메모, open a note and type 10 characters", async () => {
    const gateway = gw();
    await startWorkspace(gateway);
    await advance(30_000);
    probe.reset(); resetCalls(gateway);
    const rail = screen.getByRole("navigation", { name: "주요 영역" });
    await act(async () => { fireEvent.click(within(rail).getByRole("button", { name: "메모" })); });
    await advance(3_000);
    report("notes-open(+3s)", snapshot(gateway));
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: /Draft/ })); });
    await advance(500);
    expect(screen.getByRole("textbox", { name: "메모 본문" })).toBeInTheDocument();
    probe.reset(); resetCalls(gateway);
    let text = "";
    for (let index = 0; index < 10; index += 1) {
      text += "가";
      await act(async () => { fireEvent.change(screen.getByRole("textbox", { name: "메모 본문" }), { target: { value: text } }); });
      await advance(100, 100);
    }
    await advance(2_000);
    report("notes-type(10 chars, +2s)", snapshot(gateway));
    probe.reset(); resetCalls(gateway);
    await advance(60_000);
    report("notes-idle(60s)", snapshot(gateway));
  });

  it.each([['홈', '.home-view'], ['망가', '.online-catalog']])("navigation: open %s", async (label, selector) => {
    const gateway = gw();
    await startWorkspace(gateway);
    await advance(30_000);
    probe.reset(); resetCalls(gateway);
    await act(async () => { fireEvent.click(within(screen.getByRole("navigation", { name: "주요 영역" })).getByRole("button", { name: label })); });
    await advance(3_000);
    expect(document.querySelector(selector)).not.toBeNull();
    report(`${label}-open(+3s)`, snapshot(gateway));
  });

  it("find: open and type a query", async () => {
    const gateway = gw();
    await startWorkspace(gateway);
    await advance(30_000);
    probe.reset(); resetCalls(gateway);
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "찾기" })); });
    await advance(1_000);
    expect(screen.getByRole("combobox")).toBeInTheDocument();
    report("find-open(+1s)", snapshot(gateway));
    probe.reset(); resetCalls(gateway);
    let query = "";
    for (const char of "Draft") {
      query += char;
      await act(async () => { fireEvent.change(screen.getByRole("combobox"), { target: { value: query } }); });
      await advance(100, 100);
    }
    await advance(1_000);
    expect(screen.getByRole("combobox")).toHaveValue("Draft");
    report("find-type(5 chars,+1s)", snapshot(gateway));
  });

  it("native events: one asset-authority change, one album change, one bookmarks change", async () => {
    const gateway = gw();
    await startWorkspace(gateway);
    await advance(30_000);
    for (const event of ["library://asset-authority-changed", "library://album-authority-changed", "library://classification-authority-changed", "library://catalog-bookmarks-changed"]) {
      probe.reset(); resetCalls(gateway);
      await act(async () => { nativeBus.emit(event); });
      await advance(2_000);
      report(`native-event(${event},+2s)`, snapshot(gateway));
    }
  });

  it("workload hidden (tray): 60 s after workload://changed hidden=true", async () => {
    const gateway = gw();
    await startWorkspace(gateway);
    await advance(30_000);
    await act(async () => { nativeBus.emit("workload://changed", { lightweight: false, autoEnterMinutes: null, closeToTray: true, restricted: false, hidden: true, trayAvailable: true }); });
    await advance(61_000); // let 5 s / 10 s chains reach their hidden delay
    probe.reset(); resetCalls(gateway);
    await advance(300_000);
    report("workload-hidden(300s)", snapshot(gateway));
    await act(async () => { nativeBus.emit("workload://changed", { lightweight: false, autoEnterMinutes: null, closeToTray: true, restricted: false, hidden: false, trayAvailable: true }); });
  });

  it("lightweight mode (restricted): 300 s idle, window visible", async () => {
    const gateway = gw();
    await startWorkspace(gateway);
    await advance(30_000);
    await act(async () => { nativeBus.emit("workload://changed", { lightweight: true, autoEnterMinutes: null, closeToTray: true, restricted: true, hidden: false, trayAvailable: true }); });
    await advance(61_000);
    probe.reset(); resetCalls(gateway);
    await advance(300_000);
    report("workload-restricted(300s)", snapshot(gateway));
    await act(async () => { nativeBus.emit("workload://changed", { lightweight: false, autoEnterMinutes: null, closeToTray: true, restricted: false, hidden: false, trayAvailable: true }); });
  });

  it("unfocused but visible window: 300 s idle", async () => {
    const gateway = gw();
    await startWorkspace(gateway);
    await advance(30_000);
    vi.mocked(document.hasFocus).mockReturnValue(false);
    await act(async () => { window.dispatchEvent(new Event("blur")); });
    await advance(61_000);
    probe.reset(); resetCalls(gateway);
    await advance(300_000);
    report("unfocused-visible(300s)", snapshot(gateway));
  });
});

// Tighten-only gate (PERF-ALL-001): an idle, visible, focused Library grid must not re-render
// the workspace. Every status read returns a fresh object here, as real IPC does, so a poller
// that stores a new-but-equal value in workspace state fails this test.
// The only idle commits allowed are the cloud progress indicator's own 10 s refresh, which
// re-renders StatusCenter alone (CloudStatusCenter in App.tsx): at most 6 per minute.
const IDLE_GATE = { commitsPerMinute: 6, rootRenders: 0, tileRenders: 0 };

describe("desktop idle re-render gate (PERF-ALL-001)", () => {
  it("an idle Library grid re-renders neither the workspace nor its tiles for a minute", async () => {
    probe.state.stableCharacterStatus = false;
    const gateway = perfGateway({});
    await startWorkspace(gateway);
    await advance(30_000); // past every startup one-shot
    probe.reset(); resetCalls(gateway);
    await advance(60_000);
    const idle = snapshot(gateway);
    // The character poller really ran with fresh objects; otherwise the gate proves nothing.
    // The vault is event-driven (mount watcher), so an idle window reads its status never.
    expect(idle.gateway.getEncryptedVaultStatus ?? 0).toBe(0);
    expect(idle.invoke.character_incremental_status).toBeGreaterThan(0);
    expect(idle.renders.AppShell ?? 0).toBeLessThanOrEqual(IDLE_GATE.rootRenders);
    expect(idle.renders["thumbnailUrlCalls"] ?? 0).toBeLessThanOrEqual(IDLE_GATE.tileRenders);
    expect(Object.keys(idle.renders).filter(name => name !== "StatusCenter")).toEqual([]);
    expect(idle.commits).toBeLessThanOrEqual(IDLE_GATE.commitsPerMinute);
  });
});

it("Home revisit shows retained content while its overview refresh is pending", async () => {
  const gateway = gw();
  const overview = { failed: [], assets: { total: 0, today: 0, week: 0, images: 0, videos: 0 }, collections: { game: 0, manga: 0, movie: 0, av: 0 }, tagger: { total: 0, recommendation: 0, veto: 0 }, avPerformer: null, server: { configured: false, live: false, confirmedAt: null, capturesPending: 0 } };
  gateway.getHomeOverview = vi.fn().mockImplementation(() => new Promise(resolve => setTimeout(() => resolve(overview), 800)));
  gateway.getRevisitSlate = vi.fn().mockResolvedValue({ localDate: "2026-10-02", bundles: [{ kind: "date", assetIds: ["old-a", "old-b"] }] });
  gateway.releaseCalendar = { wishlist: vi.fn().mockResolvedValue([]), calendar: vi.fn().mockResolvedValue({ entries: [], sources: [] }) } as unknown as NonNullable<typeof gateway.releaseCalendar>;
  renderApp(gateway);
  await advance(5_000);
  const home = document.querySelector<HTMLElement>(".home-view")!;
  const thumbnail = home.querySelector("img");
  expect(home).not.toBeNull();
  console.log(`PERF home-first-entry ${JSON.stringify({ overviewReads: vi.mocked(gateway.getHomeOverview).mock.calls.length, wishlistReads: vi.mocked(gateway.releaseCalendar.wishlist).mock.calls.length, calendarReads: vi.mocked(gateway.releaseCalendar.calendar).mock.calls.length, revisitReads: vi.mocked(gateway.getRevisitSlate).mock.calls.length, thumbnails: home.querySelectorAll("img").length })}`);
  const navigate = async (name: string) => act(async () => { fireEvent.click(within(screen.getByRole("navigation", { name: "주요 영역" })).getByRole("button", { name })); });
  await navigate("에셋"); await advance(2_000);
  vi.mocked(gateway.getHomeOverview).mockClear();
  vi.mocked(gateway.getRevisitSlate).mockClear();
  vi.mocked(gateway.releaseCalendar.wishlist).mockClear();
  vi.mocked(gateway.releaseCalendar.calendar).mockClear();
  vi.mocked(gateway.getHomeOverview).mockImplementation(() => new Promise(resolve => setTimeout(() => resolve({...overview, tagger: {total: 7, recommendation: 7, veto: 0}}), 800)));
  const started = Date.now();
  await navigate("홈");
  let shownAt: number | null = null;
  for (let elapsed = 0; elapsed <= 1200; elapsed += 20) {
    if (document.querySelector('[data-motion-shown="home"]')) { shownAt = Date.now() - started; break; }
    await advance(20);
  }
  console.log(`PERF home-revisit ${JSON.stringify({ shownAtMs: shownAt, overviewReads: vi.mocked(gateway.getHomeOverview).mock.calls.length, wishlistReads: vi.mocked(gateway.releaseCalendar.wishlist).mock.calls.length, calendarReads: vi.mocked(gateway.releaseCalendar.calendar).mock.calls.length, revisitReads: vi.mocked(gateway.getRevisitSlate).mock.calls.length, sameHome: document.querySelector(".home-view") === home, sameThumbnail: document.querySelector(".home-view img") === thumbnail })}`);
  expect(shownAt).toBe(0);
  expect(document.querySelector(".home-view")).toBe(home);
  expect(document.querySelector(".home-view img")).toBe(thumbnail);
  expect(gateway.getHomeOverview).toHaveBeenCalledTimes(1);
  expect(gateway.getRevisitSlate).toHaveBeenCalledTimes(1);
  expect(gateway.releaseCalendar.calendar).toHaveBeenCalledTimes(1);
  expect(gateway.releaseCalendar.wishlist).toHaveBeenCalledTimes(1);
  await advance(1200);
  expect(within(home).getByRole("button", {name: /태거7/})).toBeVisible();
  expect(document.querySelector(".home-view")).toBe(home);
  expect(document.querySelector(".home-view img")).toBe(thumbnail);
});

it("switches the index and header together with ready content and cancels pending navigation", async () => {
  const gateway = gw();
  renderApp(gateway);
  await advance(5_000);
  const home = document.querySelector<HTMLElement>(".home-view")!;
  const header = document.querySelector<HTMLElement>('[data-chrome-slot="header"]')!;
  const homeTitle = header.textContent;
  const read = gateway.listAssets;
  let release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  gateway.listAssets = vi.fn(async query => { await pending; return read(query); });
  const navigate = async (name: string) => act(async () => { fireEvent.click(within(screen.getByRole("navigation", { name: "주요 영역" })).getByRole("button", { name })); });
  await navigate("에셋");
  await advance(100);
  expect(home).toBeVisible();
  expect(document.querySelector(".workspace-index")).toBeNull();
  expect(header.textContent).toBe(homeTitle);
  expect(header.querySelectorAll(".view-toolbar")).toHaveLength(1);
  expect(header).toHaveAttribute("inert");
  // The pending view prepares at the final width without moving the painted shell.
  expect(document.querySelector<HTMLElement>('[data-motion-view="assets"]')?.style.width).toBe("calc(100% - 208px)");
  expect(document.querySelector(".workspace-index-slot")).toHaveAttribute("data-state", "closed");
  await navigate("홈");
  expect(home).toBeVisible();
  expect(header).not.toHaveAttribute("inert");
  expect(document.querySelector('[data-motion-view="assets"]')).toBeNull();
  await navigate("에셋");
  await act(async () => { release(); });
  await advance(200);
  expect(document.querySelector('[data-motion-shown="assets"]')).not.toBeNull();
  expect(document.querySelector(".workspace-index")).toBeVisible();
  expect(document.querySelector(".workspace-index-slot")).toHaveAttribute("data-state", "open");
  expect(document.querySelector<HTMLElement>('[data-motion-view="assets"]')?.style.width).toBe("");
  expect(home).not.toBeVisible();
  expect(header.textContent).not.toBe(homeTitle);
  expect(header.querySelectorAll(".view-toolbar")).toHaveLength(1);
  await navigate("홈");
  // The index disappears at the swap and keeps its DOM for a later visit.
  expect(document.querySelector(".workspace-index-slot")).toHaveAttribute("data-state", "closed");
  expect(document.querySelector(".workspace-index-slot")).toHaveAttribute("inert");
  expect(document.querySelector(".workspace-index-clip")).not.toBeVisible();
  expect(screen.queryByRole("complementary", { name: "탐색 인덱스" })).toBeNull();
  expect(home).toBeVisible();
  expect(header.textContent).toBe(homeTitle);
  expect(header.querySelectorAll(".view-toolbar")).toHaveLength(1);
});

it("commits the content, index and header inside each browser tab snapshot update", async () => {
  const descriptor = Object.getOwnPropertyDescriptor(document, "startViewTransition");
  const animationDescriptor = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "animate");
  const animate = vi.fn(() => ({cancel: vi.fn(), onfinish: null}));
  const entries: {update: () => void; skipTransition: ReturnType<typeof vi.fn>}[] = [];
  const start = vi.fn((update: () => void) => {
    const skipTransition = vi.fn();
    entries.push({update, skipTransition});
    return {ready: Promise.resolve(), finished: new Promise<void>(() => {}), skipTransition};
  });
  Object.defineProperty(document, "startViewTransition", {configurable: true, value: start});
  Object.defineProperty(HTMLElement.prototype, "animate", {configurable: true, value: animate});
  try {
    renderApp(gw()); await advance(5_000);
    const header = document.querySelector<HTMLElement>('[data-chrome-slot="header"]')!;
    const slot = document.querySelector<HTMLElement>('.workspace-index-slot')!;
    for (const [from, to, label, index] of [['home', 'assets', '에셋', 'open'], ['assets', 'collections', '컬렉션', 'closed'], ['collections', 'assets', '에셋', 'open']] as const) {
      const oldHeader = header.textContent, oldIndex = slot.dataset.state;
      const before = entries.length;
      await act(async () => { fireEvent.click(within(screen.getByRole("navigation", {name: "주요 영역"})).getByRole("button", {name: label})); });
      await advance(200, 16);
      expect(entries).toHaveLength(before + 1);
      if (before) expect(entries[before - 1].skipTransition).toHaveBeenCalledOnce();
      expect(document.querySelector('.motion-stage')).toHaveAttribute('data-motion-shown', from);
      expect(slot.dataset.state).toBe(oldIndex);
      expect(header.textContent).toBe(oldHeader);
      const incoming = document.querySelector<HTMLElement>(`[data-motion-view="${to}"]`)!;
      expect(incoming).not.toBeVisible();
      animate.mockClear();
      act(() => {
        entries[before].update();
        expect(document.querySelector('.motion-stage')).toHaveAttribute('data-motion-shown', to);
        expect(slot).toHaveAttribute('data-state', index);
        expect(header.textContent).not.toBe(oldHeader);
        expect(header.querySelectorAll('.view-toolbar')).toHaveLength(1);
        expect(header).not.toHaveAttribute('inert');
        expect(incoming).toBeVisible();
        expect(incoming.style.width).toBe('');
        expect(incoming.style.opacity).toBe('');
      });
      expect(document.querySelectorAll('.motion-stage__view[style*="position: fixed"]')).toHaveLength(0);
      expect(animate.mock.contexts.filter(host => (host as HTMLElement).matches('.motion-stage__view, .workspace-index-clip'))).toHaveLength(0);
    }
  } finally {
    cleanup();
    if (descriptor) Object.defineProperty(document, 'startViewTransition', descriptor);
    else Reflect.deleteProperty(document, 'startViewTransition');
    if (animationDescriptor) Object.defineProperty(HTMLElement.prototype, 'animate', animationDescriptor);
    else Reflect.deleteProperty(HTMLElement.prototype, 'animate');
  }
});

it("keeps the outgoing gallery geometry through both index-width cross-fades", async () => {
  const descriptor = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "animate");
  const animate = vi.fn(() => ({cancel: vi.fn(), onfinish: null}));
  Object.defineProperty(HTMLElement.prototype, "animate", {configurable: true, value: animate});
  const originalRect = HTMLElement.prototype.getBoundingClientRect;
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
    if (!this.matches('.motion-stage, .motion-stage__view')) return originalRect.call(this);
    const slot = document.querySelector<HTMLElement>('.workspace-index-slot');
    const indexWidth = slot?.dataset.state === 'open' ? Number.parseFloat(slot.style.getPropertyValue('--workspace-index-width')) : 0;
    const fixed = this.style.position === 'fixed';
    const delta = /calc\(100% ([+-]) (\d+)px\)/.exec(this.style.width);
    const left = fixed ? Number.parseFloat(this.style.left) : 64 + indexWidth + (Number.parseFloat(this.style.left) || 0);
    const width = fixed ? Number.parseFloat(this.style.width) : 1200 - indexWidth + (delta ? Number(delta[2]) * (delta[1] === '+' ? 1 : -1) : 0);
    return {left, top: 44, width, height: 856, right: left + width, bottom: 900, x: left, y: 44, toJSON() {}};
  });
  try {
    await startWorkspace(gw());
    const navigate = async (name: string) => act(async () => { fireEvent.click(within(screen.getByRole("navigation", {name: "주요 영역"})).getByRole("button", {name})); });
    for (const [from, to, label, indexWidth] of [['assets', 'collections', '컬렉션', 0], ['collections', 'assets', '에셋', 208]] as const) {
      const outgoing = document.querySelector<HTMLElement>(`[data-motion-view="${from}"]`)!;
      const {left, width} = outgoing.getBoundingClientRect();
      animate.mockClear();
      await navigate(label);
      let started = false;
      for (let elapsed = 0; elapsed < 500; elapsed += 16) {
        await advance(16, 16);
        const incoming = document.querySelector<HTMLElement>(`[data-motion-view="${to}"]`)!;
        started = animate.mock.contexts.includes(incoming);
        const slot = document.querySelector('.workspace-index-slot')!;
        expect(slot).toHaveAttribute('data-state', (started ? indexWidth : from === 'assets' ? 208 : 0) ? 'open' : 'closed');
        expect(outgoing.getBoundingClientRect()).toMatchObject({left, width});
        if (!started) { expect(incoming.style.opacity).toBe('0'); continue; }
        expect(outgoing.style.position).toBe('fixed');
        expect(outgoing.style.width).toBe(`${width}px`);
        expect(outgoing.style.contain).toBe('layout paint size');
        expect(incoming.style.width).toBe('');
        expect(incoming.getBoundingClientRect()).toMatchObject({left: 64 + indexWidth, width: 1200 - indexWidth});
        break;
      }
      expect(started).toBe(true);
      await advance(100, 16);
      expect(outgoing.isConnected).toBe(true);
      expect(outgoing.getBoundingClientRect()).toMatchObject({left, width});
      await advance(100, 16);
      expect(outgoing.isConnected).toBe(false);
    }
  } finally {
    if (descriptor) Object.defineProperty(HTMLElement.prototype, 'animate', descriptor);
    else delete (HTMLElement.prototype as Partial<HTMLElement>).animate;
  }
});

// Tighten-only gate (PERF-ALL-001 item 4): every Library tile thumbnail mounted while scrolling
// down and back carries its content revision, so the backend serves it as immutable and a
// re-mounted tile is answered from the WebView cache instead of the media protocol and its DB
// lock. jsdom has no image cache: `mounts` models today's protocol requests (no-store), while
// `distinct` is the most a caching WebView requests. Native request counts need a real window.
const THUMBNAIL_CACHE_GATE = { unversionedMounts: 0 };

describe("desktop thumbnail cacheability gate (PERF-ALL-001)", () => {
  it("scrolling the Library grid down five screens and back mounts only revisioned thumbnails", async () => {
    const gateway = perfGateway({});
    await startWorkspace(gateway);
    await advance(30_000);
    const scroller = document.querySelector<HTMLElement>(".asset-gallery__scroll")!;
    const mounted: string[] = [];
    const record = (node: Node) => {
      if (!(node instanceof Element)) return;
      for (const image of [node, ...node.querySelectorAll("img")]) {
        const src = image instanceof HTMLImageElement ? image.getAttribute("src") : null;
        if (src?.includes("/thumbnail/")) mounted.push(src);
      }
    };
    const observer = new MutationObserver((records) => records.forEach((change) => {
      if (change.type === "attributes") record(change.target);
      else change.addedNodes.forEach(record);
    }));
    observer.observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ["src"] });
    for (const top of [900, 1_800, 2_700, 3_600, 4_500, 3_600, 2_700, 1_800, 900, 0]) {
      await act(async () => { scroller.scrollTop = top; fireEvent.scroll(scroller); });
      await advance(500);
    }
    observer.disconnect();
    const unversioned = mounted.filter((src) => !/\/thumbnail\/[^/]+\/v\d+$/.test(src));
    console.log(`PERF thumbnail-scroll-back ${JSON.stringify({ mounts: mounted.length, distinct: new Set(mounted).size, unversioned: unversioned.length })}`);
    expect(mounted.length).toBeGreaterThan(new Set(mounted).size); // tiles really re-mounted
    expect(unversioned.length).toBeLessThanOrEqual(THUMBNAIL_CACHE_GATE.unversionedMounts);
  });
});
