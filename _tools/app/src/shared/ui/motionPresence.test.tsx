import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { Dialog } from "./Dialog";
import { Menu } from "./Menu";
import { Toast } from "./Toast";
import { MotionPresence } from "./MotionPresence";
import { motionDefaults, springLinear } from "./motionCurves";
const surfaceCSS = readFileSync("src/styles/surface-motion.css", "utf8");

afterEach(() => {
  cleanup();
  document.querySelectorAll("[data-motion-ghost]").forEach(node => node.remove());
  vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals();
});

function motionEnvironment(reduced: boolean) {
  vi.stubGlobal("matchMedia", vi.fn(() => ({ matches: reduced, addEventListener: vi.fn(), removeEventListener: vi.fn() })));
  const computed = window.getComputedStyle.bind(window);
  // jsdom has no CSS animation engine. Expose its animation name to Radix, then
  // deliver animationend explicitly, just as the browser's presence clock does.
  vi.spyOn(window, "getComputedStyle").mockImplementation((node, pseudo) => {
    const style = computed(node, pseudo);
    return new Proxy(style, { get(target, key) {
      if (key === "animationName" && node instanceof HTMLElement && node.dataset.motion) return node.dataset.state === "closed" ? "ui-surface-exit" : "none";
      const value = Reflect.get(target, key);
      return typeof value === "function" ? value.bind(target) : value;
    } });
  });
}

function finishExit(node: Element) {
  const event = new Event("animationend", { bubbles: true });
  Object.defineProperty(event, "animationName", { value: "ui-surface-exit" });
  fireEvent(node, event);
}

it.each([false, true])("keeps a closed dialog until exit, reverses on reopen, and then releases presence (reduced=%s)", async reduced => {
  motionEnvironment(reduced);
  const props = { title: "Motion dialog", onClose: vi.fn(), children: <button>Action</button> };
  const { rerender } = render(<Dialog {...props} open />);
  const panel = screen.getByRole("dialog");
  const scrim = document.querySelector('[data-motion="scrim"]')!;
  rerender(<Dialog {...props} open={false} />);
  await act(async () => {});
  expect(panel.isConnected).toBe(true);
  expect(panel.dataset.state).toBe("closed");
  expect(panel.inert).toBe(true);
  expect(document.body.style.pointerEvents).not.toBe("none");
  rerender(<Dialog {...props} open />);
  await act(async () => {});
  expect(screen.getByRole("dialog")).toBe(panel);
  expect(panel.inert).toBe(false);
  expect(panel.dataset.state).toBe("open");
  rerender(<Dialog {...props} open={false} />);
  finishExit(panel);
  finishExit(scrim);
  expect(panel.isConnected).toBe(false);
  expect(scrim.isConnected).toBe(false);
});

it.each([false, true])("keeps a closed menu through exit and reuses it on rapid reopen (reduced=%s)", async reduced => {
  motionEnvironment(reduced);
  const props = { label: "Actions", trigger: "Open", items: [{ id: "one", label: "One", onSelect: vi.fn() }] };
  const { rerender } = render(<Menu {...props} open />);
  const menu = screen.getByRole("menu");
  rerender(<Menu {...props} open={false} />);
  await act(async () => {});
  expect(menu.isConnected).toBe(true);
  expect(menu.inert).toBe(true);
  expect(menu.dataset.state).toBe("closed");
  rerender(<Menu {...props} open />);
  await act(async () => {});
  expect(screen.getByRole("menu")).toBe(menu);
  expect(menu.inert).toBe(false);
  rerender(<Menu {...props} open={false} />);
  finishExit(menu);
  expect(menu.isConnected).toBe(false);
});

it.each([false, true])("retains an inert toast paint after its owner unmounts (reduced=%s)", async reduced => {
  motionEnvironment(reduced); vi.useFakeTimers();
  const { unmount } = render(<Toast onDismiss={vi.fn()}>Saved</Toast>);
  const toast = screen.getByRole("status");
  vi.spyOn(toast, "getBoundingClientRect").mockReturnValue({ width: 240, height: 48 } as DOMRect);
  act(() => vi.advanceTimersByTime(20));
  unmount();
  expect(screen.queryByRole("status")).toBeNull();
  const ghost = document.querySelector<HTMLElement>('[data-motion="toast"][data-motion-ghost]')!;
  expect(ghost).not.toBeNull();
  expect(ghost.inert).toBe(true);
  expect(ghost.getAttribute("aria-hidden")).toBe("true");
  expect(ghost.textContent).toContain("Saved");
  act(() => vi.advanceTimersToNextFrame());
  expect(ghost.dataset.state).toBe("closed");
  const duration = reduced ? motionDefaults.micro : motionDefaults.toastExit;
  act(() => vi.advanceTimersByTime(duration - 1));
  expect(ghost.isConnected).toBe(true);
  act(() => vi.advanceTimersByTime(1));
  expect(ghost.isConnected).toBe(false);
});

it("keeps the previous selection count while leaving and cancels removal on reselection", () => {
  vi.useFakeTimers();
  const { rerender } = render(<MotionPresence open><div role="toolbar">3 selected</div></MotionPresence>);
  const bar = screen.getByRole("toolbar");
  vi.spyOn(bar, "getBoundingClientRect").mockReturnValue({ width: 300 } as DOMRect);
  act(() => vi.advanceTimersToNextFrame());
  rerender(<MotionPresence open={false}><div role="toolbar">0 selected</div></MotionPresence>);
  const ghost = document.querySelector<HTMLElement>('[data-motion="selection"][data-motion-ghost]')!;
  expect(ghost.textContent).toBe("3 selected");
  expect(screen.queryByRole("toolbar")).toBeNull();
  act(() => vi.advanceTimersByTime(60));
  expect(ghost.dataset.state).toBe("closed");
  rerender(<MotionPresence open><div role="toolbar">2 selected</div></MotionPresence>);
  act(() => vi.advanceTimersByTime(500));
  expect(ghost.isConnected).toBe(false);
  expect(screen.getByRole("toolbar").textContent).toBe("2 selected");
});

it.each([false, true])("slides remaining toasts in the bottom-anchored stack only with full motion (reduced=%s)", async reduced => {
  motionEnvironment(reduced);
  document.querySelector(".ui-toast-region")?.remove();
  const animate = vi.fn(() => ({ cancel: vi.fn() }));
  vi.stubGlobal("DOMMatrixReadOnly", class { m42 = 0; });
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
    return { top: this.className === "ui-toast-region" ? 600 - this.children.length * 50 : 0, width: 0 } as DOMRect;
  });
  vi.spyOn(HTMLElement.prototype, "offsetTop", "get").mockImplementation(function (this: HTMLElement) {
    return this.parentElement ? [...this.parentElement.children].indexOf(this) * 50 : 0;
  });
  const first = <Toast key="first">First</Toast>, middle = <Toast key="middle">Middle</Toast>, last = <Toast key="last">Last</Toast>;
  const { rerender } = render(<>{first}{middle}{last}</>);
  const firstNode = screen.getByText("First").parentElement!;
  firstNode.animate = animate as unknown as HTMLElement["animate"];
  await act(async () => {});
  rerender(<>{first}{last}</>);
  await act(async () => {});
  expect(screen.getByText("First").parentElement).toBe(firstNode);
  if (reduced) expect(animate).not.toHaveBeenCalled();
  else expect(animate).toHaveBeenCalledWith([{ transform: "translateY(-50px)" }, { transform: "none" }], expect.objectContaining({ duration: 395 }));
});

it("closes a selection's nested portal immediately while its inert bar paint leaves", () => {
  vi.useFakeTimers();
  const children = <div role="toolbar">3 selected<Dialog open title="Selection picker" onClose={vi.fn()}>Choices</Dialog></div>;
  const { rerender } = render(<MotionPresence open>{children}</MotionPresence>);
  vi.spyOn(screen.getByRole("toolbar", { hidden: true }), "getBoundingClientRect").mockReturnValue({ width: 300 } as DOMRect);
  act(() => vi.advanceTimersToNextFrame());
  rerender(<MotionPresence open={false}>{children}</MotionPresence>);
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(document.body.style.pointerEvents).not.toBe("none");
  expect(document.querySelector<HTMLElement>('[data-motion="selection"][data-motion-ghost]')?.inert).toBe(true);
});

it("reclaims the current paint when a conditional dialog owner reopens mid-exit", () => {
  motionEnvironment(false); vi.useFakeTimers();
  function Conditional({ open }: { open: boolean }) {
    return open ? <Dialog open title="Conditional sheet" onClose={vi.fn()}><div className="library-sheet">Choices</div></Dialog> : null;
  }
  const { rerender } = render(<Conditional open />);
  const panel = screen.getByRole("dialog");
  vi.spyOn(panel, "getBoundingClientRect").mockReturnValue({ width: 300, height: 480 } as DOMRect);
  act(() => vi.advanceTimersByTime(20));
  rerender(<Conditional open={false} />);
  const ghost = document.querySelector<HTMLElement>('[data-motion="dialog"][data-motion-ghost]')!;
  expect(ghost).not.toBeNull();
  ghost.style.opacity = ".6";
  ghost.style.translate = "0 40px";
  rerender(<Conditional open />);
  const reopened = screen.getByRole("dialog");
  expect(ghost.isConnected).toBe(false);
  expect(reopened.style.opacity).toBe("0.6");
  expect(reopened.style.translate).toBe("0 40px");
  act(() => vi.advanceTimersByTime(500));
  expect(reopened.isConnected).toBe(true);
});

it("leaves fullscreen viewers outside the shared surface motion", () => {
  render(<Dialog open title="Viewer" variant="fullscreen" onClose={vi.fn()}>Image</Dialog>);
  expect(screen.getByRole("dialog").hasAttribute("data-motion")).toBe(false);
});

it("matches the demo spring samples and keeps reduced motion opacity-only", () => {
  expect(springLinear(.32, 1).duration).toBe(435);
  expect(springLinear(.46, .88).duration).toBe(395);
  const tokens = readFileSync("src/styles/tokens.css", "utf8");
  expect(tokens).toContain(`--spring-snappy: ${springLinear(.32, 1).easing}`);
  expect(tokens).toContain(`--spring-gentle: ${springLinear(.46, .88).easing}`);
  expect(surfaceCSS).toContain("translate: none !important; scale: none !important; transition: opacity var(--motion-micro)");
  expect(surfaceCSS).toContain("pointer-events: none !important");
  expect(surfaceCSS).toContain("var(--radix-dropdown-menu-content-transform-origin");
});
