import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BoosterPack } from "./BoosterPack";
import { CardBack } from "./CardBack";
import { demoDeck } from "./demoDeck";
import { CardSequence, createPointerTilt } from "./motion";
import { PackOpening } from "./PackOpening";
import { TradingCard } from "./TradingCard";
import { cardTiers, completesTear, revealOrder, tearProgress, tierClass } from "./types";
import { HomeDailyCard } from "../home/HomeSlots";

const fixture = demoDeck();
const originalAnimate = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "animate");
let reduced = false;
beforeEach(() => {
  vi.useFakeTimers(); reduced = false;
  vi.stubGlobal("matchMedia", vi.fn(() => ({ matches: reduced, addEventListener: vi.fn(), removeEventListener: vi.fn() })));
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
});
afterEach(() => {
  vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals();
  if (originalAnimate) Object.defineProperty(HTMLElement.prototype, "animate", originalAnimate);
  else Reflect.deleteProperty(HTMLElement.prototype, "animate");
});

describe("card tiers", () => {
  it.each(cardTiers)("maps %s to its material and layout", tier => {
    const card = { ...fixture.cards[0], tier };
    const { container } = render(<TradingCard card={card} />);
    expect(container.querySelector(`[data-tier="${tier}"]`)).toHaveClass(`card--${tier}`);
    expect(tierClass(tier).includes("fa")).toBe(["ssr", "ur", "lr"].includes(tier));
    expect(screen.getByRole("img")).toHaveAccessibleName(new RegExp(tier.toUpperCase()));
  });
  it("prints the same back with opt-in tease", () => {
    const { container, rerender } = render(<CardBack teaseTier="lr" />);
    const print = container.querySelector(".back")!.innerHTML;
    expect(container.querySelector(".card")).not.toHaveClass("hover");
    rerender(<CardBack teaseTier="lr" teasing />);
    expect(container.querySelector(".card")).toHaveClass("hover");
    expect(container.querySelector(".back")!.innerHTML).toBe(print);
  });
});

it("coalesces tilt into one animation frame using the latest pointer and cancels on leave", () => {
  const element = document.createElement("div");
  vi.spyOn(element, "getBoundingClientRect").mockReturnValue({ left: 0, top: 0, width: 100, height: 100 } as DOMRect);
  let callback: FrameRequestCallback | undefined;
  const request = vi.fn((fn: FrameRequestCallback) => { callback = fn; return 8; });
  vi.stubGlobal("requestAnimationFrame", request); const cancel = vi.fn(); vi.stubGlobal("cancelAnimationFrame", cancel);
  const tilt = createPointerTilt(element, false);
  tilt.move(10, 10); tilt.move(90, 80); expect(request).toHaveBeenCalledTimes(1);
  callback!(0); expect(element.style.getPropertyValue("--mx")).toBe("90%"); expect(element).toHaveClass("active");
  tilt.move(40, 40); tilt.reset(); expect(cancel).toHaveBeenCalledWith(8); expect(element.style.getPropertyValue("--mx")).toBe("");
  createPointerTilt(element, true).move(10, 10); expect(request).toHaveBeenCalledTimes(2);
});

it("completes at 76% or a forward flick; short/slow/reverse drags spring back", () => {
  expect(tearProgress(69.92, 100)).toBeCloseTo(.76);
  expect(completesTear(.76)).toBe(true); expect(completesTear(.759)).toBe(false);
  expect(completesTear(.13, 1.11)).toBe(true); expect(completesTear(.12, 2)).toBe(false);
  expect(completesTear(.4, -2)).toBe(false); expect(tearProgress(-10, 100)).toBe(0);
});

it("tears by keyboard exactly once", () => {
  const opened = vi.fn(); render(<BoosterPack onOpened={opened} />);
  const grip = screen.getByRole("button", { name: /팩 뜯기/ });
  fireEvent.keyDown(grip, { key: "Enter" }); fireEvent.keyDown(grip, { key: " " }); expect(opened).toHaveBeenCalledTimes(1);
});

function pointer(target: Element, type: string, x: number, time: number) {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.entries({ pointerId: 1, pointerType: "mouse", button: 0, clientX: x, timeStamp: time }).forEach(([key, value]) => Object.defineProperty(event, key, { value }));
  fireEvent(target, event);
}

it("springs back a short drag, ignores cancellation flicks, and completes a threshold drag", () => {
  const opened = vi.fn(); const { container } = render(<BoosterPack onOpened={opened} />);
  const pack = container.querySelector<HTMLElement>(".pack")!;
  vi.spyOn(pack, "getBoundingClientRect").mockReturnValue({ width: 100 } as DOMRect);
  const grip = screen.getByRole("button", { name: /팩 뜯기/ });
  pointer(grip, "pointerdown", 0, 1); pointer(grip, "pointermove", 20, 201); pointer(grip, "pointerup", 20, 211);
  expect(opened).not.toHaveBeenCalled(); expect(pack.style.getPropertyValue("--tear")).toBe("0");
  pointer(grip, "pointerdown", 0, 300); pointer(grip, "pointermove", 20, 302); pointer(grip, "pointercancel", 20, 304);
  expect(opened).not.toHaveBeenCalled(); expect(pack.style.getPropertyValue("--tear")).toBe("0");
  pointer(grip, "pointerdown", 0, 500); pointer(grip, "pointermove", 70, 1000);
  pointer(grip, "pointercancel", 70, 1001);
  expect(opened).toHaveBeenCalledTimes(1); expect(pack.style.getPropertyValue("--tear")).toBe("1");
});

it("finishes a fast forward flick below the threshold", () => {
  const opened = vi.fn(); const { container } = render(<BoosterPack onOpened={opened} />);
  vi.spyOn(container.querySelector(".pack")!, "getBoundingClientRect").mockReturnValue({ width: 100 } as DOMRect);
  const grip = screen.getByRole("button", { name: /팩 뜯기/ });
  pointer(grip, "pointerdown", 0, 1); pointer(grip, "pointermove", 20, 3); pointer(grip, "pointerup", 20, 4);
  expect(opened).toHaveBeenCalledTimes(1);
});

it("all-reveal sorts low to high and leaves the stable last best card", () => {
  const cards = [fixture.cards[5], fixture.cards[2], fixture.cards[0], { ...fixture.cards[5], id: "tied-best" }];
  expect(revealOrder(cards, new Set())).toEqual([cards[2].id, cards[1].id, cards[0].id]);
  expect(revealOrder(cards, new Set(["tied-best"]))).toEqual([cards[2].id, cards[1].id]);
});

it("reduced animation only crossfades, and stop cancels its own wait", async () => {
  const element = document.createElement("div"), cancel = vi.fn();
  const animate = vi.fn(() => ({ finished: new Promise(() => {}), cancel }));
  element.animate = animate as unknown as typeof element.animate;
  const sequence = new CardSequence(true);
  const animation = sequence.animate(element, [{ transform: "translateY(100px)", opacity: 0 }, { transform: "none", opacity: 1 }], 500);
  expect(animate.mock.calls[0]).toEqual([[{ opacity: 0 }, { opacity: 1 }], expect.objectContaining({ duration: 180, delay: 0 })]);
  const wait = sequence.wait(5000); sequence.stop(); await Promise.all([animation, wait]); expect(cancel).toHaveBeenCalled();
});

it("runs reduced opening, leaves best after 모두 공개, and reaches results after final flip", async () => {
  reduced = true; render(<PackOpening cards={fixture.cards} cover={fixture.cover} onClose={vi.fn()} />);
  fireEvent.keyDown(screen.getByRole("button", { name: /팩 뜯기/ }), { key: "Enter" });
  await act(async () => { await vi.advanceTimersByTimeAsync(1600); });
  expect(screen.getAllByRole("button", { name: "카드 뒤집기" })).toHaveLength(6);
  fireEvent.click(screen.getByRole("button", { name: "모두 공개" }));
  await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
  const last = screen.getByRole("button", { name: "카드 뒤집기" }); expect(last).toHaveAttribute("data-tier", "lr");
  expect(screen.getByRole("status")).toHaveTextContent("마지막 한 장");
  fireEvent.click(last); await act(async () => { await vi.advanceTimersByTimeAsync(400); });
  expect(screen.getByRole("status")).toHaveTextContent("공개 완료"); expect(screen.queryByRole("button", { name: "별빛 한정 연출 건너뛰기" })).not.toBeInTheDocument();
  expect(document.querySelector(".pack-opening__slot .lr-banner")).not.toBeNull(); expect(document.querySelector(".card-reveal-fx")).toBeNull();
});

it("skip immediately shows results and stale opening cannot overwrite them", async () => {
  render(<PackOpening cards={fixture.cards} cover={fixture.cover} onClose={vi.fn()} />);
  fireEvent.keyDown(screen.getByRole("button", { name: /팩 뜯기/ }), { key: "Enter" });
  fireEvent.click(screen.getByRole("button", { name: "건너뛰기" }));
  await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
  expect(screen.getByRole("status")).toHaveTextContent("공개 완료"); expect(screen.queryByRole("button", { name: "카드 뒤집기" })).not.toBeInTheDocument();
});

it("honours a motion preference change during all-reveal without leaving controls locked", async () => {
  reduced = true;
  const { rerender } = render(<PackOpening cards={fixture.cards} cover={fixture.cover} onClose={vi.fn()} />);
  fireEvent.keyDown(screen.getByRole("button", { name: /팩 뜯기/ }), { key: "Enter" });
  await act(async () => { await vi.advanceTimersByTimeAsync(1600); });
  fireEvent.click(screen.getByRole("button", { name: "모두 공개" }));
  reduced = false; rerender(<PackOpening cards={fixture.cards} cover={fixture.cover} onClose={vi.fn()} />);
  await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
  expect(screen.getByRole("button", { name: "모두 공개" })).not.toBeDisabled();
  fireEvent.click(screen.getByRole("button", { name: "모두 공개" }));
  await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
  expect(screen.getAllByRole("button", { name: "카드 뒤집기" })).toHaveLength(1);
});

it("sequences stack exit, settle and deal with bounded WAAPI promises, then skips LR with Escape", async () => {
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
    const isStage = this.classList.contains("pack-opening__stage"), isPack = this.classList.contains("pack-opening__wrapper");
    const index = this.parentElement ? [...this.parentElement.children].indexOf(this) : 0;
    return { left: isStage ? 0 : isPack ? 405 : index * 150, top: 100, width: isStage ? 1000 : isPack ? 190 : 128, height: isStage ? 500 : isPack ? 380 : 179 } as DOMRect;
  });
  const animations: { element: HTMLElement; frames: Keyframe[]; cancel: ReturnType<typeof vi.fn> }[] = [];
  Object.defineProperty(HTMLElement.prototype, "animate", { configurable: true, writable: true, value: vi.fn() });
  vi.spyOn(HTMLElement.prototype, "animate").mockImplementation(function (this: HTMLElement, frames) {
    const cancel = vi.fn(); animations.push({ element: this, frames: frames as Keyframe[], cancel });
    return { finished: new Promise(() => {}), cancel } as unknown as Animation;
  });
  render(<PackOpening cards={fixture.cards} cover={fixture.cover} onClose={vi.fn()} />);
  fireEvent.keyDown(screen.getByRole("button", { name: /팩 뜯기/ }), { key: "Enter" });
  await act(async () => { await vi.advanceTimersByTimeAsync(6000); });
  expect(screen.getAllByRole("button", { name: "카드 뒤집기" })).toHaveLength(6);
  expect(animations[0].element).toHaveClass("pack-opening__stack");
  expect(animations[0].frames[0].transform).toContain("scale(");
  expect(animations.filter(animation => animation.element.classList.contains("pack-opening__slot"))).toHaveLength(6);
  expect(animations.every(animation => animation.cancel.mock.calls.length > 0)).toBe(true);
  fireEvent.click(screen.getAllByRole("button", { name: "카드 뒤집기" })[5]);
  await act(async () => { await vi.advanceTimersByTimeAsync(800); });
  expect(screen.getByRole("button", { name: "별빛 한정 연출 건너뛰기" })).toBeInTheDocument();
  fireEvent.keyDown(document, { key: "Escape" });
  expect(screen.queryByRole("button", { name: "별빛 한정 연출 건너뛰기" })).not.toBeInTheDocument();
  expect(screen.getAllByRole("button", { name: "카드 뒤집기" })).toHaveLength(5);
});

/** Opens the pack with instant animations, then switches `animate` to controllable ones for the cut-in. */
async function openForCutin() {
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
    const c = this.classList, index = this.parentElement ? [...this.parentElement.children].indexOf(this) : 0;
    if (c.contains("pack-opening__stage") || c.contains("cutin")) return { left: 0, top: 0, width: 1000, height: 500 } as DOMRect;
    if (c.contains("cutin-card")) return { left: 375, top: 160, width: 250, height: 350 } as DOMRect;
    if (c.contains("pack-opening__wrapper")) return { left: 405, top: 100, width: 190, height: 380 } as DOMRect;
    return { left: index * 150, top: 100, width: 128, height: 179 } as DOMRect;
  });
  type Log = { element: HTMLElement; frames: Keyframe[]; cancel: ReturnType<typeof vi.fn>; finish: () => void; name: string };
  const log: Log[] = []; let controlled = false;
  const nameOf = (element: HTMLElement) => element.classList.contains("cutin-dim") ? "cutin-dim" : element.classList.contains("cutin-card") ? "cutin-card" : element.parentElement?.classList.contains("cutin-banner") ? "cutin-banner" : "other";
  Object.defineProperty(HTMLElement.prototype, "animate", { configurable: true, writable: true, value: vi.fn() });
  vi.spyOn(HTMLElement.prototype, "animate").mockImplementation(function (this: HTMLElement, frames) {
    const cancel = vi.fn(); let finish = () => {};
    const finished = controlled ? new Promise<void>(resolve => { finish = resolve; }) : Promise.resolve();
    if (controlled) log.push({ element: this, frames: frames as Keyframe[], cancel, finish, name: nameOf(this) });
    return { finished, cancel } as unknown as Animation;
  });
  render(<PackOpening cards={fixture.cards} cover={fixture.cover} onClose={vi.fn()} />);
  fireEvent.keyDown(screen.getByRole("button", { name: /팩 뜯기/ }), { key: "Enter" });
  await act(async () => { await vi.advanceTimersByTimeAsync(6000); });
  controlled = true;
  const flush = () => act(async () => { await vi.advanceTimersByTimeAsync(0); });
  const finishLast = async (name: string) => { const entry = [...log].reverse().find(item => item.name === name)!; entry.finish(); await flush(); return entry; };
  return { log, flush, finishLast };
}
const stage = () => document.querySelector(".pack-opening__stage")!;
const bursting = () => stage().querySelectorAll(".cutin .card-reveal-fx").length;

it("LR cut-in runs as one awaited timeline: flip, then dim and travel, then burst, banner, return", async () => {
  const { log, flush, finishLast } = await openForCutin();
  fireEvent.click(screen.getAllByRole("button", { name: "카드 뒤집기" })[5]);
  await act(async () => { await vi.advanceTimersByTimeAsync(300); });
  // The flip is still running in the slot: no cut-in, and no burst on the slot.
  expect(stage().querySelector(".cutin")).toBeNull(); expect(stage().querySelectorAll(".pack-opening__slot .card-reveal-fx")).toHaveLength(0);
  await act(async () => { await vi.advanceTimersByTimeAsync(200); });
  const slotCard = stage().querySelectorAll<HTMLElement>(".pack-opening__slot .trading-card")[5];
  // Dim and travel start together, from the slot rect (scale 128/250), and the slot card hides under the clone.
  expect(log.map(entry => entry.name)).toEqual(["cutin-dim", "cutin-card"]);
  expect(String(log[1].frames[0].transform)).toContain("scale(0.512)");
  expect(log[1].frames[1].transform).toBe("none"); expect(slotCard.style.visibility).toBe("hidden");
  // Nothing after the travel starts before it has actually finished.
  await finishLast("cutin-dim"); expect(bursting()).toBe(0); expect(log).toHaveLength(2);
  await finishLast("cutin-card");
  expect(bursting()).toBe(2); expect(log.map(entry => entry.name)).toEqual(["cutin-dim", "cutin-card", "cutin-card"]);
  expect(log[2].frames.map(frame => frame.transform)).toEqual(["none", "scale(1.06)", "none"]);
  // The banner waits for the burst peak (200 ms after arrival).
  await act(async () => { await vi.advanceTimersByTimeAsync(150); }); expect(log.some(entry => entry.name === "cutin-banner")).toBe(false);
  await act(async () => { await vi.advanceTimersByTimeAsync(60); }); expect(log.filter(entry => entry.name === "cutin-banner")).toHaveLength(1);
  log[2].finish(); await flush();
  await finishLast("cutin-banner");
  // Hold: no return before 1.2 s after arrival.
  await act(async () => { await vi.advanceTimersByTimeAsync(900); }); expect(log).toHaveLength(4);
  await act(async () => { await vi.advanceTimersByTimeAsync(200); });
  expect(log.map(entry => entry.name).slice(3)).toEqual(["cutin-banner", "cutin-banner"]); expect(log[4].frames[1].opacity).toBe(0);
  // Return: banner out first, then travel home and undim together.
  await finishLast("cutin-banner");
  expect(log.map(entry => entry.name).slice(5).sort()).toEqual(["cutin-card", "cutin-dim"]);
  const home = log.find((entry, i) => i >= 5 && entry.name === "cutin-card")!;
  expect(home.frames[0].transform).toBe("none"); expect(String(home.frames[1].transform)).toContain("scale(0.512)");
  await finishLast("cutin-dim"); expect(stage().querySelector(".cutin")).not.toBeNull();
  await finishLast("cutin-card");
  expect(stage().querySelector(".cutin")).toBeNull(); expect(slotCard.style.visibility).toBe("");
  expect(log.filter(entry => entry.name === "cutin-dim")).toHaveLength(2);
});

it("tap or Escape skips the LR cut-in at any step, cancels its animations and restores the slot card", async () => {
  const { log, flush, finishLast } = await openForCutin();
  fireEvent.click(screen.getAllByRole("button", { name: "카드 뒤집기" })[5]);
  await act(async () => { await vi.advanceTimersByTimeAsync(500); });
  await finishLast("cutin-dim"); await finishLast("cutin-card"); // arrived: burst playing
  expect(bursting()).toBe(2);
  const slotCard = stage().querySelectorAll<HTMLElement>(".pack-opening__slot .trading-card")[5]; expect(slotCard.style.visibility).toBe("hidden");
  const count = log.length;
  fireEvent.click(screen.getByRole("button", { name: "별빛 한정 연출 건너뛰기" })); await flush();
  expect(stage().querySelector(".cutin")).toBeNull(); expect(bursting()).toBe(0); expect(slotCard.style.visibility).toBe("");
  await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
  expect(log).toHaveLength(count); // nothing from the old timeline starts after the skip
});

it("Escape during the travel skips; the grid continues", async () => {
  const { log } = await openForCutin();
  fireEvent.click(screen.getAllByRole("button", { name: "카드 뒤집기" })[5]);
  await act(async () => { await vi.advanceTimersByTimeAsync(500); });
  fireEvent.keyDown(document, { key: "Escape" });
  expect(stage().querySelector(".cutin")).toBeNull(); expect(log.length).toBe(2);
  await act(async () => { await vi.advanceTimersByTimeAsync(3000); });
  expect(screen.getAllByRole("button", { name: "카드 뒤집기" })).toHaveLength(5); expect(bursting()).toBe(0); expect(log.length).toBe(2);
});

it("모두 공개 stops on LR; flipping it twice triggers one cut-in", async () => {
  const { log } = await openForCutin();
  fireEvent.click(screen.getByRole("button", { name: "모두 공개" }));
  await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
  expect(log.filter(entry => entry.name === "cutin-dim")).toHaveLength(0); expect(stage().querySelector(".cutin")).toBeNull();
  const last = screen.getByRole("button", { name: "카드 뒤집기" });
  fireEvent.click(last); fireEvent.click(last);
  await act(async () => { await vi.advanceTimersByTimeAsync(500); });
  expect(stage().querySelectorAll(".cutin")).toHaveLength(1); expect(log.filter(entry => entry.name === "cutin-dim")).toHaveLength(1);
});

it("Home's reserved slot opens a full-window preview and returns focus on close", async () => {
  render(<HomeDailyCard />);
  const opener = screen.getByRole("button", { name: "오늘의 카드 미리보기 열기" }); opener.focus(); fireEvent.click(opener);
  expect(screen.getByRole("dialog", { name: "오늘의 카드 미리보기" })).toHaveClass("ui-dialog--fullscreen");
  fireEvent.click(screen.getByRole("button", { name: "닫기" }));
  await act(async () => { await vi.advanceTimersByTimeAsync(500); });
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument(); expect(opener).toHaveFocus();
});
