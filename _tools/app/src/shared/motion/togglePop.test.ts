import { afterEach, beforeEach, expect, it, vi, type Mock } from "vitest";
import { popToggle } from "./togglePop";

type FakeAnimation = { target: Element; keyframes: Keyframe[]; options: KeyframeAnimationOptions; cancel: Mock<() => void>; onfinish: (() => void) | null; oncancel: (() => void) | null };
let animations: FakeAnimation[];
const animateDescriptor = Object.getOwnPropertyDescriptor(Element.prototype, "animate");

function installAnimate() {
  Object.defineProperty(Element.prototype, "animate", {
    configurable: true, writable: true,
    value(this: Element, keyframes: Keyframe[], options: KeyframeAnimationOptions) {
      const animation: FakeAnimation = { target: this, keyframes, options, onfinish: null, oncancel: null, cancel: vi.fn(() => animation.oncancel?.()) };
      animations.push(animation);
      return animation as unknown as Animation;
    },
  });
}

function toggleButton(pressed: boolean | null = false) {
  const button = document.createElement("button");
  if (pressed !== null) button.setAttribute("aria-pressed", String(pressed));
  button.innerHTML = '<svg aria-hidden="true"></svg>';
  document.body.append(button);
  return button;
}

const flush = () => new Promise<void>(resolve => setTimeout(resolve, 0));
const finishAll = () => { for (const animation of [...animations]) animation.onfinish?.(); };

beforeEach(() => {
  animations = [];
  installAnimate();
  vi.stubGlobal("matchMedia", () => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
});

afterEach(() => {
  document.body.replaceChildren();
  if (animateDescriptor) Object.defineProperty(Element.prototype, "animate", animateDescriptor);
  else Reflect.deleteProperty(Element.prototype, "animate");
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

it("turning on pops the icon and bursts six dots once the button shows the new state", async () => {
  const button = toggleButton(false);
  popToggle(button, true);
  // Nothing plays until the toggle's state lands on the button.
  expect(animations).toHaveLength(0);
  button.setAttribute("aria-pressed", "true");
  await flush();
  const burst = button.querySelector(".toggle-pop-burst");
  expect(burst).toHaveAttribute("aria-hidden", "true");
  expect(burst?.querySelectorAll(".toggle-pop-dot")).toHaveLength(6);
  expect(button).toHaveClass("toggle-pop-host");
  expect(animations[0].target).toBe(button.querySelector("svg"));
  expect(animations[0].keyframes.map(frame => frame.scale)).toEqual([1, 0.82, 1.22, 1]);
  expect(animations[0].options.duration).toBe(420);
  expect(animations.slice(1)).toHaveLength(6);
  expect(animations.slice(1).every(animation => animation.options.duration === 380 && animation.keyframes[1].opacity === 0)).toBe(true);
  finishAll();
  expect(button.querySelector(".toggle-pop-burst")).toBeNull();
  expect(button).not.toHaveClass("toggle-pop-host");
});

it("turning off only dips the icon, without a burst", () => {
  const button = toggleButton(false);
  popToggle(button, false);
  expect(animations).toHaveLength(1);
  expect(animations[0].keyframes.map(frame => frame.scale)).toEqual([1, 0.88, 1]);
  expect(animations[0].options.duration).toBe(180);
  expect(button.querySelector(".toggle-pop-burst")).toBeNull();
});

it("animates the button itself when it has no icon, and leaves an already positioned host alone", () => {
  const button = document.createElement("button");
  button.style.position = "absolute";
  document.body.append(button);
  popToggle(button, true);
  expect(animations[0].target).toBe(button);
  expect(button).not.toHaveClass("toggle-pop-host");
  expect(button.querySelectorAll(".toggle-pop-dot")).toHaveLength(6);
});

it("a new pop cancels the running one on the same button", () => {
  const button = toggleButton(null);
  popToggle(button, true);
  const first = [...animations];
  popToggle(button, true);
  expect(first.every(animation => animation.cancel.mock.calls.length === 1)).toBe(true);
  expect(button.querySelectorAll(".toggle-pop-burst")).toHaveLength(1);
});

it("cancelling removes the burst", () => {
  const button = toggleButton(null);
  popToggle(button, true);
  animations[3].cancel();
  expect(button.querySelector(".toggle-pop-burst")).toBeNull();
});

it("a failed toggle, or a button that moved to another item, never pops", async () => {
  vi.useFakeTimers();
  const failed = toggleButton(false);
  popToggle(failed, true);
  vi.advanceTimersByTime(5000);
  failed.setAttribute("aria-pressed", "true");
  await vi.runAllTimersAsync();
  expect(animations).toHaveLength(0);

  const moved = toggleButton(false);
  moved.dataset.toggleKey = "a";
  popToggle(moved, true);
  moved.dataset.toggleKey = "b";
  moved.setAttribute("aria-pressed", "true");
  await vi.runAllTimersAsync();
  expect(animations).toHaveLength(0);
});

it("does nothing with reduced motion, without Web Animations or for a detached button", () => {
  vi.stubGlobal("matchMedia", () => ({ matches: true, addEventListener() {}, removeEventListener() {} }));
  const button = toggleButton(null);
  popToggle(button, true);
  expect(animations).toHaveLength(0);
  vi.stubGlobal("matchMedia", () => ({ matches: false, addEventListener() {}, removeEventListener() {} }));

  popToggle(document.createElement("button"), true);
  expect(animations).toHaveLength(0);

  Reflect.deleteProperty(Element.prototype, "animate");
  expect(() => popToggle(button, true)).not.toThrow();
  expect(button.querySelector(".toggle-pop-burst")).toBeNull();
});

it("never throws when the animation itself fails", () => {
  Object.defineProperty(Element.prototype, "animate", { configurable: true, writable: true, value() { throw new Error("boom"); } });
  const button = toggleButton(null);
  expect(() => popToggle(button, true)).not.toThrow();
  expect(button.querySelector(".toggle-pop-burst")).toBeNull();
});
