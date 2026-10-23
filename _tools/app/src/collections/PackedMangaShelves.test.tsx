import { Profiler } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { PackedMangaShelves } from "./PackedMangaShelves";

let frames: Map<number, FrameRequestCallback>;
beforeEach(() => {
  frames = new Map();
  let id = 0;
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => { frames.set(++id, callback); return id; });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => frames.delete(id));
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
async function flushFrames(rounds = 8) {
  for (let round = 0; round < rounds; round++) {
    await act(async () => {
      const callbacks = [...frames.values()]; frames.clear();
      callbacks.forEach(callback => callback(0));
    });
  }
}

const works = Array.from({ length: 20 }, (_, index) => ({ id: `work-${index}`, count: 48 }));
const rect = (top: number, height: number) => ({ top, bottom: top + height, left: 0, right: 800, width: 800, height, x: 0, y: top, toJSON: () => null });

function shelfGeometry() {
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockImplementation(function (this: HTMLElement) { return this.dataset.testid === "scroll" ? 300 : 0; });
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
    if (this.classList.contains("manga-shelf-row")) {
      const index = Array.from(this.parentElement!.children).indexOf(this);
      return rect(index * 300 - screen.getByTestId("scroll").scrollTop, 300);
    }
    if (this.classList.contains("manga-shelf-list")) return rect(-screen.getByTestId("scroll").scrollTop, 0);
    return rect(0, this.dataset.testid === "scroll" ? 300 : 0);
  });
}

function requests() {
  const pending = new Map<string, (count: number) => void>();
  const prepare = vi.fn((work: typeof works[number]) => new Promise<number>(resolve => pending.set(work.id, resolve)));
  const resolve = async (index: number, count = 48) => { await act(async () => { pending.get(`work-${index}`)!(count); }); await flushFrames(); };
  return { prepare, resolve, pending };
}

function renderShelves(prepare: (work: typeof works[number], signal: AbortSignal) => Promise<number>) {
  return render(<div data-testid="scroll" style={{ overflowY: "auto" }}>
    <PackedMangaShelves items={works} identity="list" label="목록" scale={1} estimate={work => work.count}
      cachedCount={() => undefined} prepare={prepare} renderRun={run => <button>{run.work.id}:{run.start}:{run.count}</button>} />
  </div>);
}

it("fills a jumped-to shelf before the preceding works and reprioritises each free read slot", async () => {
  shelfGeometry();
  const { prepare, resolve } = requests();
  renderShelves(prepare);
  expect(prepare.mock.calls.map(([work]) => work.id)).toEqual(["work-0", "work-1"]);
  const scroller = screen.getByTestId("scroll");
  scroller.scrollTop = 2400;
  fireEvent.scroll(scroller);
  // Work 0 is still blocked. A single free slot must go to the visible work, not work 2.
  await resolve(1);
  await waitFor(() => expect(prepare.mock.calls.map(([work]) => work.id)).toEqual(["work-0", "work-1", "work-8"]));
  await resolve(8);
  expect(within(screen.getByRole("group", { name: "9번째 선반" })).getByRole("button", { name: "work-8:0:48" })).toBeTruthy();
  expect(prepare).not.toHaveBeenCalledWith(works[2], expect.anything());
  expect(prepare.mock.calls[3][0].id).toBe("work-7");
  // A later jump must update priorities again; no one-shot observer retains the old demand.
  scroller.scrollTop = 4500;
  fireEvent.scroll(scroller);
  await resolve(7);
  await waitFor(() => expect(prepare.mock.calls[4][0].id).toBe("work-15"));
  await resolve(15);
  expect(within(screen.getByRole("group", { name: "16번째 선반" })).getByRole("button", { name: "work-15:0:48" })).toBeTruthy();
});

it("compensates the viewport when a late count above it adds shelves", async () => {
  shelfGeometry();
  const { prepare, resolve, pending } = requests();
  renderShelves(prepare);
  const scroller = screen.getByTestId("scroll");
  scroller.scrollTop = 2420;
  fireEvent.scroll(scroller);
  const before = screen.getByRole("group", { name: "9번째 선반" }).getBoundingClientRect().top;
  await resolve(0, 144);
  expect(scroller.scrollTop).toBe(3020);
  expect(screen.getByRole("group", { name: "11번째 선반" }).getBoundingClientRect().top).toBe(before);
  // Works inside the render window are read nearest first, two at a time; drain them until the one under the viewport is asked for.
  for (let round = 0; round < 6 && !prepare.mock.calls.some(([work]) => work.id === "work-8"); round++) {
    const waiting = [...pending.keys()].filter(id => id !== "work-0");
    for (const id of waiting) { await resolve(Number(id.slice(5)), 0 + works[Number(id.slice(5))].count); pending.delete(id); }
    if (!waiting.length) await flushFrames();
  }
  expect(prepare.mock.calls.some(([work]) => work.id === "work-8")).toBe(true);
  await resolve(8);
  expect(within(screen.getByRole("group", { name: "11번째 선반" })).getByRole("button", { name: "work-8:0:48" })).toBeTruthy();
});

it("uses cached counts across the whole list without preparing a prefix", () => {
  const prepare = vi.fn();
  render(<PackedMangaShelves items={works} identity="cached" label="목록" scale={1} estimate={() => 1}
    cachedCount={work => work.count} prepare={prepare} renderRun={run => <button>{run.work.id}</button>} />);
  expect(screen.getByRole("button", { name: "work-0" })).toBeTruthy();
  expect(screen.queryByRole("button", { name: "work-19" })).toBeNull();
  expect(prepare).not.toHaveBeenCalled();
});

it("keeps painted runs mounted while later works finish filling their shelf", async () => {
  const items = [{ id: "a", count: 40 }, { id: "b", count: 20 }, { id: "c", count: 5 }, { id: "d", count: 5 }];
  const pending = new Map<string, (count: number) => void>();
  const prepare = vi.fn((work: typeof items[number]) => new Promise<number>(resolve => pending.set(work.id, resolve)));
  render(<PackedMangaShelves items={items} identity="packed" label="목록" scale={1} estimate={work => work.count}
    cachedCount={() => undefined} prepare={prepare} renderRun={run => <button>{run.work.id}:{run.start}:{run.count}</button>} />);
  await act(async () => { pending.get("a")!(40); pending.get("b")!(20); });
  await flushFrames();
  const first = screen.getByRole("group", { name: "1번째 선반" });
  const painted = within(first).getAllByRole("button");
  expect(painted.map(button => button.textContent)).toEqual(["a:0:40", "b:0:8"]);
  await waitFor(() => expect(prepare).toHaveBeenCalledTimes(4));
  await act(async () => { pending.get("c")!(5); pending.get("d")!(5); });
  await flushFrames();
  expect(within(first).getAllByRole("button")[0]).toBe(painted[0]);
  expect(within(screen.getByRole("group", { name: "2번째 선반" })).getAllByRole("button").map(button => button.textContent)).toEqual(["b:8:12", "c:0:5", "d:0:5"]);
});

it("unmounts far spines, preserves row positions and reuses cached reads on return", async () => {
  shelfGeometry();
  const prepare = vi.fn();
  const commits = vi.fn();
  const renderRun = vi.fn((run: { work: typeof works[number]; count: number }) =>
    <>{Array.from({ length: run.count }, (_, index) => <span className="manga-spine" key={index}>{run.work.id}</span>)}</>);
  const { container } = render(<Profiler id="shelves" onRender={commits}><div data-testid="scroll" style={{ overflowY: "auto" }}>
    <PackedMangaShelves items={works} identity="cached" label="shelves" scale={1} estimate={work => work.count}
      cachedCount={work => work.count} prepare={prepare} renderRun={renderRun} />
  </div></Profiler>);
  const scroller = screen.getByTestId("scroll");
  const rows = [...container.querySelectorAll(".manga-shelf-row")];
  const spines = (index: number) => rows[index].querySelectorAll(".manga-spine");
  expect(spines(0)).toHaveLength(48);
  expect(spines(8)).toHaveLength(0);
  scroller.scrollTop = 10; fireEvent.scroll(scroller); await flushFrames();
  const renders = renderRun.mock.calls.length;
  commits.mockClear();
  for (let offset = 11; offset <= 20; offset++) {
    scroller.scrollTop = offset; fireEvent.scroll(scroller);
  }
  await flushFrames();
  expect(renderRun).toHaveBeenCalledTimes(renders);
  expect(commits).not.toHaveBeenCalled();
  scroller.scrollTop = 2400; fireEvent.scroll(scroller); await flushFrames();
  expect(spines(0)).toHaveLength(0);
  expect(spines(8)).toHaveLength(48);
  expect(container.querySelectorAll(".manga-spine").length).toBeLessThanOrEqual(5 * 48);
  expect([...container.querySelectorAll(".manga-shelf-row")]).toEqual(rows);
  scroller.scrollTop = 0; fireEvent.scroll(scroller); await flushFrames();
  expect(spines(0)).toHaveLength(48);
  expect(spines(8)).toHaveLength(0);
  expect(prepare).not.toHaveBeenCalled();
});

it("batches count arrivals and keeps packing when the estimates were accurate", async () => {
  shelfGeometry();
  const { prepare, pending } = requests();
  const estimate = vi.fn((work: typeof works[number]) => work.count);
  const { container } = render(<div data-testid="scroll" style={{ overflowY: "auto" }}>
    <PackedMangaShelves items={works} identity="list" label="shelves" scale={1} estimate={estimate}
      cachedCount={() => undefined} prepare={prepare} renderRun={run => <button>{run.work.id}</button>} />
  </div>);
  const reads = estimate.mock.calls.length;
  await act(async () => { pending.get("work-0")!(48); pending.get("work-1")!(48); });
  expect(container.querySelector("button")).toBeNull();
  await flushFrames();
  expect(container.querySelectorAll("button")).toHaveLength(2);
  // Only the arriving works are compared with their estimates; the list is not packed again.
  expect(estimate.mock.calls.length - reads).toBe(2);
  const scroller = screen.getByTestId("scroll");
  const packed = estimate.mock.calls.length;
  const painted = container.querySelector("button");
  scroller.scrollTop = 10; fireEvent.scroll(scroller); await flushFrames();
  expect(estimate).toHaveBeenCalledTimes(packed);
  expect(container.querySelector("button")).toBe(painted);
});


it("retains nearby rows across direction changes and publishes only one entering row per frame", async () => {
  shelfGeometry();
  const { container } = render(<div data-testid="scroll" style={{ overflowY: "auto" }}>
    <PackedMangaShelves items={works} identity="cached" label="shelves" scale={1}
      estimate={work => work.count} cachedCount={work => work.count} prepare={vi.fn()}
      renderRun={run => <button>{run.work.id}</button>} />
  </div>);
  await flushFrames();
  const scroller = screen.getByTestId("scroll");
  const first = screen.getByRole("button", { name: "work-0" });
  scroller.scrollTop = 600; fireEvent.scroll(scroller); await flushFrames();
  expect(screen.getByRole("button", { name: "work-0" })).toBe(first);
  scroller.scrollTop = 0; fireEvent.scroll(scroller); await flushFrames();
  expect(screen.getByRole("button", { name: "work-0" })).toBe(first);
  scroller.scrollTop = 2400; fireEvent.scroll(scroller);
  await flushFrames(1); // The scroll frame only updates the requested range.
  expect(screen.queryByRole("button", { name: "work-8" })).toBeNull();
  await flushFrames(1);
  expect(screen.getByRole("button", { name: "work-8" })).toBeTruthy();
  expect(container.querySelectorAll("button")).toHaveLength(1);
  expect(screen.queryByRole("button", { name: "work-0" })).toBeNull();
  await flushFrames(1);
  expect(container.querySelectorAll("button")).toHaveLength(2);
  await flushFrames(1);
  expect(container.querySelectorAll("button")).toHaveLength(3);
});
