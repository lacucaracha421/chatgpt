import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { PackedMangaShelves } from "./PackedMangaShelves";

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

const works = Array.from({ length: 20 }, (_, index) => ({ id: `work-${index}`, count: 48 }));
const rect = (top: number, height: number) => ({ top, bottom: top + height, left: 0, right: 800, width: 800, height, x: 0, y: top, toJSON: () => null });

function shelfGeometry() {
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockImplementation(function (this: HTMLElement) { return this.dataset.testid === "scroll" ? 300 : 0; });
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
    if (this.classList.contains("manga-shelf-row")) {
      const index = Array.from(this.parentElement!.children).indexOf(this);
      return rect(index * 300 - screen.getByTestId("scroll").scrollTop, 300);
    }
    return rect(0, this.dataset.testid === "scroll" ? 300 : 0);
  });
}

function requests() {
  const pending = new Map<string, (count: number) => void>();
  const prepare = vi.fn((work: typeof works[number]) => new Promise<number>(resolve => pending.set(work.id, resolve)));
  const resolve = async (index: number, count = 48) => { await act(async () => { pending.get(`work-${index}`)!(count); }); };
  return { prepare, resolve };
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
  const { prepare, resolve } = requests();
  renderShelves(prepare);
  const scroller = screen.getByTestId("scroll");
  scroller.scrollTop = 2420;
  fireEvent.scroll(scroller);
  const before = screen.getByRole("group", { name: "9번째 선반" }).getBoundingClientRect().top;
  await resolve(0, 144);
  expect(scroller.scrollTop).toBe(3020);
  expect(screen.getByRole("group", { name: "11번째 선반" }).getBoundingClientRect().top).toBe(before);
  await waitFor(() => expect(prepare.mock.calls[2][0].id).toBe("work-8"));
  await resolve(8);
  expect(within(screen.getByRole("group", { name: "11번째 선반" })).getByRole("button", { name: "work-8:0:48" })).toBeTruthy();
});

it("uses cached counts across the whole list without preparing a prefix", () => {
  const prepare = vi.fn();
  render(<PackedMangaShelves items={works} identity="cached" label="목록" scale={1} estimate={() => 1}
    cachedCount={work => work.count} prepare={prepare} renderRun={run => <button>{run.work.id}</button>} />);
  expect(screen.getByRole("button", { name: "work-19" })).toBeTruthy();
  expect(prepare).not.toHaveBeenCalled();
});

it("keeps painted runs mounted while later works finish filling their shelf", async () => {
  const items = [{ id: "a", count: 40 }, { id: "b", count: 20 }, { id: "c", count: 5 }, { id: "d", count: 5 }];
  const pending = new Map<string, (count: number) => void>();
  const prepare = vi.fn((work: typeof items[number]) => new Promise<number>(resolve => pending.set(work.id, resolve)));
  render(<PackedMangaShelves items={items} identity="packed" label="목록" scale={1} estimate={work => work.count}
    cachedCount={() => undefined} prepare={prepare} renderRun={run => <button>{run.work.id}:{run.start}:{run.count}</button>} />);
  await act(async () => { pending.get("a")!(40); pending.get("b")!(20); });
  const first = screen.getByRole("group", { name: "1번째 선반" });
  const painted = within(first).getAllByRole("button");
  expect(painted.map(button => button.textContent)).toEqual(["a:0:40", "b:0:8"]);
  await waitFor(() => expect(prepare).toHaveBeenCalledTimes(4));
  await act(async () => { pending.get("c")!(5); pending.get("d")!(5); });
  expect(within(first).getAllByRole("button")[0]).toBe(painted[0]);
  expect(within(screen.getByRole("group", { name: "2번째 선반" })).getAllByRole("button").map(button => button.textContent)).toEqual(["b:8:12", "c:0:5", "d:0:5"]);
});
