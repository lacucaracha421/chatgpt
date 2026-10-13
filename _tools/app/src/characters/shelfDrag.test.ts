import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ShelfBridge } from "../shared/ui/ShelfScroller";
import { NO_OVER, ShelfDrag, type DragOver, type DropIntent, type ShelfDragHost } from "./shelfDrag";
import type { OrderKind } from "./shelfOrder";

const TRACK = { left: 100, top: 40, width: 600, height: 200 };
const CARD = { width: 132, height: 170, pitch: 144 };
let cleanups: (() => void)[] = [];

type Spec = [OrderKind | "take-out", string];

/** A shelf of `specs` laid out like the real one, with rectangles that follow the track's scroll. */
function mountShelf(specs: Spec[], overrides: Partial<ShelfDragHost> = {}) {
  const root = document.createElement("div");
  const track = document.createElement("div");
  root.append(track);
  document.body.append(root);
  Object.defineProperties(track, { clientWidth: { value: TRACK.width }, scrollWidth: { value: specs.length * CARD.pitch } });
  track.getBoundingClientRect = () => new DOMRect(TRACK.left, TRACK.top, TRACK.width, TRACK.height);
  const cards = specs.map(([kind, id], index) => {
    const card = document.createElement("article");
    if (kind === "take-out") card.setAttribute("data-take-out", "");
    else { card.dataset.orderKind = kind; card.dataset.orderId = id; }
    card.innerHTML = `<button class="series-character__open">${id}</button><button class="series-character__info">i</button>`;
    card.getBoundingClientRect = () => new DOMRect(TRACK.left + index * CARD.pitch - track.scrollLeft, TRACK.top, CARD.width, CARD.height);
    track.append(card);
    return card;
  });
  const bridge: ShelfBridge = { locked: false, track };
  const events = { lifts: [] as [OrderKind, string][], overs: [] as DragOver[], ends: [] as (DropIntent | null)[] };
  const host: ShelfDragHost = {
    band: (kind, id) => { const ids = specs.filter(([k]) => k === kind).map(([, value]) => value); return ids.includes(id) ? ids : null; },
    canPutIn: true, canTakeOut: specs.some(([kind]) => kind === "take-out"),
    onLift: (kind, id) => { events.lifts.push([kind, id]); },
    onOver: over => { events.overs.push(over); },
    onEnd: intent => { events.ends.push(intent); },
    ...overrides,
  };
  const drag = new ShelfDrag(root, bridge, () => host);
  cleanups.push(drag.attach(), () => root.remove());
  const button = (id: string) => cards.find(card => card.dataset.orderId === id)!.querySelector<HTMLElement>(".series-character__open")!;
  return { root, track, cards, bridge, events, button, card: (id: string) => cards.find(card => card.dataset.orderId === id)! };
}

const pointer = (type: string, x: number, y: number, target: EventTarget = document) =>
  target.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, pointerType: "mouse", button: 0, clientX: x, clientY: y }));
/** The middle of the card in slot `index`. */
const slotX = (index: number, scroll = 0) => TRACK.left + index * CARD.pitch + CARD.width / 2 - scroll;
const Y = TRACK.top + 60;
const hold = () => vi.advanceTimersByTime(250);

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { cleanups.forEach(cleanup => cleanup()); cleanups = []; vi.useRealTimers(); document.documentElement.className = ""; document.body.innerHTML = ""; });

describe("hold or pan", () => {
  it("lifts a card held still for 0.25 s: the shelf stops panning and a floating copy follows the pointer", () => {
    const shelf = mountShelf([["character", "a"], ["character", "b"]]);
    pointer("pointerdown", slotX(1), Y, shelf.button("b"));
    vi.advanceTimersByTime(249);
    expect(shelf.events.lifts).toEqual([]);
    expect(shelf.bridge.locked).toBe(false);
    vi.advanceTimersByTime(1);
    expect(shelf.events.lifts).toEqual([["character", "b"]]);
    expect(shelf.bridge.locked).toBe(true);
    const ghost = document.querySelector<HTMLElement>(".shelf-drag-ghost")!;
    expect(ghost).toBeTruthy();
    expect(ghost.querySelector("[data-order-id]")).toBeNull();
    expect(ghost.querySelector(".series-character__info")).toBeNull();
    expect(shelf.card("b").dataset.reorderState).toBe("source");
    pointer("pointermove", slotX(1) + 30, Y + 12);
    expect(ghost.style.transform).toBe(`translate(${slotX(1) + 30 - (slotX(1) - TRACK.left - CARD.pitch)}px, ${Y + 12 - (Y - TRACK.top)}px)`);
  });

  it("leaves a press that moved 4 px or more before the hold to the shelf's own pan", () => {
    const shelf = mountShelf([["character", "a"], ["character", "b"]]);
    pointer("pointerdown", slotX(1), Y, shelf.button("b"));
    pointer("pointermove", slotX(1) + 3, Y);
    pointer("pointermove", slotX(1) + 4, Y);
    hold();
    expect(shelf.events.lifts).toEqual([]);
    expect(shelf.bridge.locked).toBe(false);
    expect(document.querySelector(".shelf-drag-ghost")).toBeNull();
  });

  it("treats a short press as an ordinary click", () => {
    const shelf = mountShelf([["character", "a"], ["character", "b"]]);
    pointer("pointerdown", slotX(1), Y, shelf.button("b"));
    vi.advanceTimersByTime(100);
    pointer("pointerup", slotX(1), Y);
    hold();
    expect(shelf.events.lifts).toEqual([]);
    const click = vi.fn();
    shelf.button("b").addEventListener("click", click);
    shelf.button("b").click();
    expect(click).toHaveBeenCalledTimes(1);
  });

  it("ignores other buttons, touch, the edit button and cards outside the bands", () => {
    const shelf = mountShelf([["character", "a"], ["character", "b"]], { band: () => null });
    pointer("pointerdown", slotX(1), Y, shelf.button("b"));
    hold();
    expect(shelf.events.lifts).toEqual([]);
    const other = mountShelf([["character", "a"], ["character", "b"]]);
    other.button("b").dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, pointerType: "touch", button: 0 }));
    other.button("b").dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, pointerType: "mouse", button: 2 }));
    other.card("b").querySelector(".series-character__info")!.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, pointerType: "mouse", button: 0 }));
    hold();
    expect(other.events.lifts).toEqual([]);
  });
});

describe("carrying inside a band", () => {
  it("slides the neighbours open a gap, and a drop asks for the whole band in its new order", () => {
    const shelf = mountShelf([["character", "a"], ["character", "b"], ["character", "c"], ["character", "d"]]);
    pointer("pointerdown", slotX(0), Y, shelf.button("a"));
    hold();
    pointer("pointermove", slotX(2) + 40, Y);
    // a moves to the third slot; b and c step back one slot each.
    expect(shelf.card("a").style.transform).toBe("translateX(288px)");
    expect(shelf.card("b").style.transform).toBe("translateX(-144px)");
    expect(shelf.card("c").style.transform).toBe("translateX(-144px)");
    expect(shelf.card("d").style.transform).toBe("");
    expect(shelf.track.dataset.reordering).toBe("true");
    pointer("pointerup", slotX(2) + 40, Y);
    expect(shelf.events.ends).toEqual([{ type: "reorder", kind: "character", ids: ["b", "c", "a", "d"] }]);
    // Released in the same step: no transform, no clone, the shelf pans again.
    expect(shelf.cards.every(card => card.style.transform === "")).toBe(true);
    expect(document.querySelector(".shelf-drag-ghost")).toBeNull();
    expect(shelf.bridge.locked).toBe(false);
    expect(shelf.track.dataset.reordering).toBeUndefined();
  });

  it("keeps a group inside the group band however far it is carried", () => {
    const shelf = mountShelf([["group", "g1"], ["group", "g2"], ["character", "c1"], ["character", "c2"]]);
    pointer("pointerdown", slotX(0), Y, shelf.button("g1"));
    hold();
    pointer("pointermove", slotX(3), Y);
    expect(shelf.card("c1").style.transform).toBe("");
    expect(shelf.card("c2").style.transform).toBe("");
    pointer("pointerup", slotX(3), Y);
    expect(shelf.events.ends).toEqual([{ type: "reorder", kind: "group", ids: ["g2", "g1"] }]);
  });

  it("keeps a character inside the character band", () => {
    const shelf = mountShelf([["group", "g1"], ["character", "c1"], ["character", "c2"]], { canPutIn: false });
    pointer("pointerdown", slotX(2), Y, shelf.button("c2"));
    hold();
    pointer("pointermove", slotX(0), Y);
    pointer("pointerup", slotX(0), Y);
    expect(shelf.events.ends).toEqual([{ type: "reorder", kind: "character", ids: ["c2", "c1"] }]);
  });

  it("dropping where it started changes nothing and the click that follows does not open the card", () => {
    const shelf = mountShelf([["character", "a"], ["character", "b"]]);
    pointer("pointerdown", slotX(0), Y, shelf.button("a"));
    hold();
    pointer("pointerup", slotX(0), Y);
    expect(shelf.events.ends).toEqual([null]);
    const click = vi.fn();
    shelf.root.addEventListener("click", click);
    shelf.button("a").click();
    expect(click).not.toHaveBeenCalled();
    vi.advanceTimersByTime(101);
    shelf.button("a").click();
    expect(click).toHaveBeenCalledTimes(1);
  });
});

describe("leaving the band", () => {
  it("shows 그룹에 넣기 over the middle of a group card and drops into it", () => {
    const shelf = mountShelf([["group", "g1"], ["group", "g2"], ["character", "c1"], ["character", "c2"]]);
    pointer("pointerdown", slotX(2), Y, shelf.button("c1"));
    hold();
    pointer("pointermove", slotX(1), Y);
    expect(shelf.events.overs[shelf.events.overs.length - 1]).toEqual({ groupId: "g2", takeOut: false });
    // No gap is open while a drop place is under the card.
    expect(shelf.card("c2").style.transform).toBe("");
    pointer("pointerup", slotX(1), Y);
    expect(shelf.events.ends).toEqual([{ type: "into", targetId: "c1", groupId: "g2" }]);
  });

  it("does not put in at the edge of a group card (outside the central 60%)", () => {
    const shelf = mountShelf([["group", "g1"], ["character", "c1"], ["character", "c2"]]);
    pointer("pointerdown", slotX(2), Y, shelf.button("c2"));
    hold();
    pointer("pointermove", TRACK.left + 5, Y);
    expect(shelf.events.overs).toEqual([]);
    pointer("pointerup", TRACK.left + 5, Y);
    expect(shelf.events.ends).toEqual([{ type: "reorder", kind: "character", ids: ["c2", "c1"] }]);
  });

  it("never offers a group to put a group into", () => {
    const shelf = mountShelf([["group", "g1"], ["group", "g2"]]);
    pointer("pointerdown", slotX(0), Y, shelf.button("g1"));
    hold();
    pointer("pointermove", slotX(1), Y);
    expect(shelf.events.overs).toEqual([]);
  });

  it("keeps the put-in card's place until it leaves the shelf, and shows it again at once when the change was not stored", async () => {
    for (const stored of [true, false]) {
      const shelf = mountShelf([["group", "g1"], ["character", "c1"], ["character", "c2"]], { onEnd: intent => { shelf.events.ends.push(intent); return Promise.resolve(stored); } });
      pointer("pointerdown", slotX(2), Y, shelf.button("c2"));
      hold();
      pointer("pointermove", slotX(0), Y);
      pointer("pointerup", slotX(0), Y);
      await vi.advanceTimersByTimeAsync(0);
      if (stored) {
        expect(shelf.card("c2").dataset.reorderState).toBe("source");
        expect(shelf.bridge.locked).toBe(true);
        shelf.card("c2").remove();
        await vi.advanceTimersByTimeAsync(0);
      }
      expect(shelf.bridge.locked).toBe(false);
      expect(shelf.card("c1").dataset.reorderState).toBeUndefined();
      expect(shelf.events.ends).toEqual([{ type: "into", targetId: "c2", groupId: "g1" }]);
      if (!stored) expect(shelf.card("c2").dataset.reorderState).toBeUndefined();
    }
  });

  it("drops on the 그룹에서 빼기 slot of a group view", () => {
    const shelf = mountShelf([["take-out", ""], ["character", "c1"], ["character", "c2"]], { canPutIn: false });
    pointer("pointerdown", slotX(1), Y, shelf.button("c1"));
    hold();
    pointer("pointermove", slotX(0), Y);
    expect(shelf.events.overs[shelf.events.overs.length - 1]).toEqual({ groupId: null, takeOut: true });
    pointer("pointerup", slotX(0), Y);
    expect(shelf.events.ends).toEqual([{ type: "out", targetId: "c1" }]);
  });
});

describe("cancelling", () => {
  it("Esc puts everything back and reports no change", () => {
    const shelf = mountShelf([["character", "a"], ["character", "b"], ["character", "c"]]);
    pointer("pointerdown", slotX(0), Y, shelf.button("a"));
    hold();
    pointer("pointermove", slotX(2), Y);
    const escape = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
    document.dispatchEvent(escape);
    expect(escape.defaultPrevented).toBe(true);
    expect(shelf.events.ends).toEqual([null]);
    expect(shelf.cards.every(card => card.style.transform === "")).toBe(true);
    expect(document.querySelector(".shelf-drag-ghost")).toBeNull();
    expect(shelf.bridge.locked).toBe(false);
    // The release afterwards is not a second drop.
    pointer("pointerup", slotX(2), Y);
    expect(shelf.events.ends).toEqual([null]);
  });

  it("keeps swallowing the click while the button is still held after Esc", () => {
    const shelf = mountShelf([["character", "a"], ["character", "b"]]);
    pointer("pointerdown", slotX(0), Y, shelf.button("a"));
    hold();
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    vi.advanceTimersByTime(500);
    const click = vi.fn();
    shelf.root.addEventListener("click", click);
    pointer("pointerup", slotX(0), Y);
    shelf.button("a").click();
    expect(click).not.toHaveBeenCalled();
    vi.advanceTimersByTime(101);
    shelf.button("a").click();
    expect(click).toHaveBeenCalledTimes(1);
  });

  it("dropping off the shelf cancels, and the card can be carried again afterwards", () => {
    const shelf = mountShelf([["character", "a"], ["character", "b"]]);
    pointer("pointerdown", slotX(0), Y, shelf.button("a"));
    hold();
    pointer("pointermove", slotX(1), TRACK.top + TRACK.height + 200);
    expect(shelf.card("b").style.transform).toBe("");
    pointer("pointerup", slotX(1), TRACK.top + TRACK.height + 200);
    expect(shelf.events.ends).toEqual([null]);
    pointer("pointerdown", slotX(0), Y, shelf.button("a"));
    hold();
    expect(shelf.events.lifts).toHaveLength(2);
  });
});

describe("edge zones", () => {
  it("scroll the shelf by themselves and move the gap with it", () => {
    const shelf = mountShelf(Array.from({ length: 10 }, (_, index) => ["character", `c${index}`] as Spec));
    pointer("pointerdown", slotX(0), Y, shelf.button("c0"));
    hold();
    pointer("pointermove", TRACK.left + TRACK.width - 10, Y);
    const before = shelf.track.scrollLeft;
    vi.advanceTimersByTime(16 * 5);
    expect(shelf.track.scrollLeft).toBeGreaterThan(before);
    pointer("pointermove", TRACK.left + TRACK.width / 2, Y);
    const resting = shelf.track.scrollLeft;
    vi.advanceTimersByTime(16 * 5);
    expect(shelf.track.scrollLeft).toBe(resting);
    // The wheel scrolls the track too: the gap follows without any pointer move.
    shelf.track.scrollLeft = 0;
    shelf.track.dispatchEvent(new Event("scroll"));
    pointer("pointerup", TRACK.left + TRACK.width / 2, Y);
    expect(shelf.events.ends[0]).toMatchObject({ type: "reorder" });
  });
});

it("NO_OVER is the resting drop state", () => {
  expect(NO_OVER).toEqual({ groupId: null, takeOut: false });
});
