// PERF-ALL-001: render/commit harness for the desktop React app.
// The measurement suite runs only with LAKOMICS_PERF=1 (it prints one `PERF <label> <json>` line
// per measurement and asserts no thresholds), from _tools/app/:
//   LAKOMICS_PERF=1 npx vitest run src/app/App.perf.test.tsx --reporter=verbose --silent=false
// The idle gate at the end always runs: its thresholds only tighten (docs/agents/implementation.md,
// "Performance work"). Raise one only with a measured, justified reason.
// Method: the whole App sits under one React <Profiler>; `commits` counts its onRender
// callbacks (one per React commit that touched the tree). Selected components are wrapped
// through vi.mock so their render-function calls are counted, and `tiles` counts gallery
// tile renders via `thumbnailUrl`. Status reads return fresh objects, like real IPC.
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
  return { ...m, thumbnailUrl: (...args: Parameters<typeof m.thumbnailUrl>) => { probe.count("tile(thumbnailUrl)"); return m.thumbnailUrl(...args); } };
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

/** Start the app, open the library and let startup work settle (fake time). */
async function startWorkspace(gateway: ReturnType<typeof perfGateway>) {
  renderApp(gateway);
  await advance(5_000);
  expect(screen.getByRole("main", { name: "라이브러리 작업 공간" })).toBeInTheDocument();
}

// Shared by the measurement suite and the idle gate.
// Lazy views resolve through real module loading; warm them so fake time can drive them.
beforeAll(async () => {
  await Promise.all([import("../collections/CollectionBrowser"), import("../notes/NotesView"), import("../collections/CollectionOverlay")]);
});
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date", "requestAnimationFrame", "cancelAnimationFrame"] });
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
    report("startup(5s)", snapshot(gateway));
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
    for (let index = 0; index < 5; index += 1) {
      await act(async () => { fireEvent.keyDown(screen.getByRole("dialog"), { key: "ArrowRight" }); });
      await advance(200);
    }
    await advance(1_000);
    report("viewer-next(x5 cumulative)", snapshot(gateway));
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
    await act(async () => { fireEvent.click(screen.getByText("여기에 적어보세요…")); });
    await advance(500);
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
    expect(idle.renders["tile(thumbnailUrl)"] ?? 0).toBeLessThanOrEqual(IDLE_GATE.tileRenders);
    expect(Object.keys(idle.renders).filter(name => name !== "StatusCenter")).toEqual([]);
    expect(idle.commits).toBeLessThanOrEqual(IDLE_GATE.commitsPerMinute);
  });
});
