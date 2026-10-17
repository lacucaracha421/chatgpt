import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { CollectionCase, type CaseData } from "../case/CollectionCase";
import { WorkZoomObject, WorkZoomProvider, WorkZoomStage } from "./WorkZoom";

afterEach(cleanup);
const data: CaseData = { title: "게임", front: "/front", platform: "sw2", publisher: "배급사", privacy: false };

/** The work screen's one-finger gesture: the stage picks turn or scroll once, and the other never happens in that gesture. */
function setup() {
  render(<div data-testid="page" style={{ overflowY: "auto" }}>
    <WorkZoomProvider workId="w" reset={0}><WorkZoomStage><WorkZoomObject><CollectionCase data={data} open={false} onOpenChange={() => {}} /></WorkZoomObject></WorkZoomStage></WorkZoomProvider>
  </div>);
  const page = screen.getByTestId("page");
  Object.defineProperty(page, "scrollHeight", { value: 2000 });
  Object.defineProperty(page, "clientHeight", { value: 800 });
  page.scrollTop = 300;
  const kase = screen.getByRole("group", { name: "케이스" });
  const finger = (type: "Down" | "Move" | "Up", dx = 0, dy = 0) => fireEvent[`pointer${type}` as "pointerDown"](kase, { pointerId: 1, pointerType: "touch", button: 0, clientX: 200 + dx, clientY: 400 + dy });
  return { page, kase, finger };
}

it("turns the case on a mostly horizontal drag that drifts upward, and the page does not scroll", () => {
  const { page, kase, finger } = setup();
  finger("Down");
  for (const [dx, dy] of [[-4, -1], [-9, -5], [-20, -12], [-60, -26]]) finger("Move", dx, dy);
  expect(Number(kase.dataset.angle)).not.toBe(28);
  expect(page.scrollTop).toBe(300);
  // Sliding up after the turn began still does not scroll.
  finger("Move", -70, -120); finger("Move", -75, -200);
  expect(page.scrollTop).toBe(300);
  finger("Up", -75, -200);
  expect(page.scrollTop).toBe(300);
});

it("scrolls the page on a mostly vertical drag and leaves the case still", () => {
  const { page, kase, finger } = setup();
  finger("Down");
  for (const [dx, dy] of [[-2, -6], [-4, -16], [-30, -60], [-60, -90]]) finger("Move", dx, dy);
  expect(kase).toHaveAttribute("data-angle", "28");
  expect(page.scrollTop).toBeGreaterThan(300);
  finger("Up", -60, -90);
  expect(kase).toHaveAttribute("data-angle", "28");
});

it("does not turn the case before the axis is chosen, then follows the finger from where it touched", () => {
  const { kase, finger } = setup();
  finger("Down");
  finger("Move", -6, 0);
  expect(kase).toHaveAttribute("data-angle", "28");
  finger("Move", -12, 0);
  finger("Move", -42, 0);
  expect(Number(kase.dataset.angle)).toBeCloseTo(28 - 42 * .6, 5);
});

it("commits the dragged angle to the case when the finger lifts, without leaving the live transform behind", () => {
  const { kase, finger } = setup();
  finger("Down"); finger("Move", -12, 0); finger("Move", -52, 0);
  expect(Number(/rotateY\(([-\d.]+)deg\)/.exec(kase.style.transform)?.[1])).toBeCloseTo(-3.2, 5);
  finger("Up", -52, 0);
  expect(kase.style.transform).toBe("");
  expect(parseFloat(kase.style.getPropertyValue("--ry"))).toBeCloseTo(-3.2, 5);
});
