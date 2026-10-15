import { renderHook } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { CardsApi, CardState } from "./api";
import { isLocalPreview, useCardWarmup, warmArt, warmTargets, WARM_CONCURRENCY, WARM_MAX_IDS } from "./warmup";

const preview = (id: string) => `http://lakomics.localhost/preview/${id}/1280`;
function fakeApi(local: readonly string[]) {
  const api = {
    state: vi.fn(), open: vi.fn(), keep: vi.fn(), pack: vi.fn(), album: vi.fn(), subscribe: vi.fn(() => () => undefined),
    art: vi.fn(async (id: string, _cutout?: boolean, localOnly?: boolean) => {
      if (local.includes(id)) return preview(id);
      if (localOnly) throw new Error("not in the library");
      return `https://remote.test/${id}`;
    }),
  };
  return api as typeof api & CardsApi;
}
const idle = (run: () => void) => { const timer = setTimeout(run, 0); return () => clearTimeout(timer); };
const settle = (ms = 0) => vi.advanceTimersByTimeAsync(ms);
const stateWith = (prefetch: CardState["prefetch"]) => ({ prefetch }) as CardState;

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

it("reads only art ids from the prefetch hint, in order, without repeats and bounded", () => {
  expect(warmTargets(undefined)).toEqual({ art: [], cutouts: [] });
  expect(warmTargets({} as CardState)).toEqual({ art: [], cutouts: [] });
  expect(warmTargets(stateWith([
    { packId: "d-20261015", assetIds: ["b", "a", "b"], cutoutAssetIds: ["a"] },
    { packId: "b-20261015", assetIds: ["a", "c"] },
  ]))).toEqual({ art: ["b", "a", "c"], cutouts: ["a"] });
  const many = Array.from({ length: 40 }, (_, index) => `art${index}`);
  expect(warmTargets(stateWith([{ packId: "d-20261015", assetIds: many }])).art).toHaveLength(WARM_MAX_IDS);
  expect(isLocalPreview(preview("a_1-B"))).toBe(true);
  expect(isLocalPreview("https://remote.test/a/1280x")).toBe(false);
});

it("warms with limited concurrency and never leaves the library: local lookups only", async () => {
  const api = fakeApi(["a", "b", "c", "d", "e"]);
  const resolvers: (() => void)[] = []; let inFlight = 0, peak = 0;
  const load = vi.fn((_url: string) => new Promise<void>(resolve => { inFlight++; peak = Math.max(peak, inFlight); resolvers.push(() => { inFlight--; resolve(); }); }));
  warmArt(api, ["a", "b", "c", "d", "e"], { load, idle, busy: () => false });
  await settle(5);
  expect(load).toHaveBeenCalledTimes(WARM_CONCURRENCY);
  for (let round = 0; round < 5; round++) { resolvers.splice(0).forEach(done => done()); await settle(5); }
  expect(load.mock.calls.map(([url]) => url).sort()).toEqual(["a", "b", "c", "d", "e"].map(preview));
  expect(peak).toBeLessThanOrEqual(WARM_CONCURRENCY);
  expect(api.art.mock.calls.every(call => call[1] === false && call[2] === true)).toBe(true); // never a signed remote ticket
  for (const call of [api.state, api.open, api.keep, api.pack, api.album]) expect(call).not.toHaveBeenCalled();
});

it("skips art that is not in the library without loading anything", async () => {
  const api = fakeApi(["here"]), load = vi.fn(async () => undefined);
  warmArt(api, ["gone", "here", "missing"], { load, idle, busy: () => false });
  await settle(50);
  expect(load).toHaveBeenCalledTimes(1); expect(load).toHaveBeenCalledWith(preview("here"));
});

it("waits while the user is busy and starts when quiet, and a canceller stops the rest", async () => {
  const api = fakeApi(["a", "b", "c"]); let busy = true, finish!: () => void;
  const load = vi.fn((_url: string) => new Promise<void>(resolve => { finish = resolve; }));
  const stop = warmArt(api, ["a", "b", "c"], { load, idle, busy: () => busy, concurrency: 1, retryMs: 100 });
  await settle(1000);
  expect(load).not.toHaveBeenCalled(); expect(api.art).not.toHaveBeenCalled();
  busy = false; await settle(150);
  expect(load).toHaveBeenCalledTimes(1);
  stop(); finish(); await settle(1000);
  expect(load).toHaveBeenCalledTimes(1);
});

it("skips ids it already warmed, so only a changed list costs work", async () => {
  const api = fakeApi(["a", "b", "c"]), load = vi.fn(async () => undefined), options = { load, idle, busy: () => false };
  warmArt(api, ["a", "b"], options); await settle(50);
  expect(load).toHaveBeenCalledTimes(2);
  warmArt(api, ["a", "b"], options); await settle(50);
  expect(load).toHaveBeenCalledTimes(2);
  warmArt(api, ["a", "b", "c"], options); await settle(50);
  expect(load).toHaveBeenCalledTimes(3); expect(load).toHaveBeenLastCalledWith(preview("c"));
});

it("the hook starts for a prefetch list, ignores a state without one, and re-runs when the list changes", async () => {
  const api = fakeApi(["a", "b"]), load = vi.fn(async () => undefined), options = { load, idle, busy: () => false };
  const { rerender, unmount } = renderHook(({ state }) => useCardWarmup(api, state, true, options), { initialProps: { state: undefined as CardState | undefined } });
  await settle(50); expect(api.art).not.toHaveBeenCalled();
  rerender({ state: stateWith([]) }); await settle(50); expect(api.art).not.toHaveBeenCalled();
  rerender({ state: stateWith([{ packId: "d-20261015", assetIds: ["a"] }]) }); await settle(50);
  expect(load).toHaveBeenCalledTimes(1);
  rerender({ state: stateWith([{ packId: "d-20261015", assetIds: ["a"] }]) }); await settle(50);
  expect(load).toHaveBeenCalledTimes(1); // same list, nothing new
  rerender({ state: stateWith([{ packId: "d-20261015", assetIds: ["a"] }, { packId: "b-20261015", assetIds: ["b"] }]) }); await settle(50);
  expect(load).toHaveBeenCalledTimes(2);
  unmount();
});

it("does not warm while inactive", async () => {
  const api = fakeApi(["a"]), load = vi.fn(async () => undefined);
  renderHook(() => useCardWarmup(api, stateWith([{ packId: "d-20261015", assetIds: ["a"] }]), false, { load, idle, busy: () => false }));
  await settle(50); expect(api.art).not.toHaveBeenCalled();
});
