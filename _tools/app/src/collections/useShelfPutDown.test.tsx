import { useState } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useShelfPutDown } from "./useShelfPutDown";

afterEach(cleanup);
function view() {
  const opened = vi.fn();
  function Shelf() {
    const [pick, setPick] = useState<string | null>("first");
    const events = useShelfPutDown(() => setPick(null));
    return <div data-testid="shelf" {...events}>
      {["first", "second"].map(id => <button key={id} className="collection-card" aria-label={id} aria-selected={pick === id}
        onClick={() => pick === id ? opened(id) : setPick(id)}><span>{id}</span></button>)}
      <div data-testid="plank" /><div data-testid="gap" /><div className="ui-section-bar" data-testid="toolbar"><span>정렬</span></div>
      <button>보기</button><input aria-label="검색" />
    </div>;
  }
  render(<Shelf />);
  return { opened, shelf: screen.getByTestId("shelf"), first: screen.getByRole("button", { name: "first" }) };
}
function pointer(target: Element, type: string, pointerType: string, x = 20, y = 20) {
  const event = new MouseEvent(type, { bubbles: true, button: 0, clientX: x, clientY: y });
  Object.defineProperties(event, { pointerId: { value: 1 }, pointerType: { value: pointerType }, isPrimary: { value: true } });
  fireEvent(target, event);
}
describe.each(["mouse", "touch"])("empty shelf input: %s", input => {
  it.each(["shelf", "plank", "gap"])("puts down on %s without opening and keeps the cases mounted", target => {
    const { first, opened } = view();
    const empty = screen.getByTestId(target);
    pointer(empty, "pointerdown", input); pointer(empty, "pointerup", input);
    fireEvent.click(empty, { detail: 1 });
    expect(first.getAttribute("aria-selected")).toBe("false");
    expect(screen.getByRole("button", { name: "first" })).toBe(first);
    expect(opened).not.toHaveBeenCalled();
  });
  it.each(["drag", "scroll", "wheel", "cancel"])("keeps the pick after %s, then allows a fresh empty tap", action => {
    const { shelf, first } = view();
    pointer(shelf, "pointerdown", input);
    if (action === "drag") { pointer(shelf, "pointermove", input, 100); pointer(shelf, "pointermove", input); }
    if (action === "scroll") fireEvent.scroll(shelf);
    if (action === "wheel") fireEvent.wheel(shelf);
    if (action === "cancel") pointer(shelf, "pointercancel", input);
    pointer(shelf, "pointerup", input);
    fireEvent.click(shelf, { detail: 1 });
    expect(first.getAttribute("aria-selected")).toBe("true");
    pointer(shelf, "pointerdown", input); pointer(shelf, "pointerup", input); fireEvent.click(shelf, { detail: 1 });
    expect(first.getAttribute("aria-selected")).toBe("false");
  });
  it("preserves controls, switches the pick and opens the picked case", () => {
    const { first, opened } = view();
    for (const control of [screen.getByText("정렬"), screen.getByRole("button", { name: "보기" }), screen.getByRole("textbox")]) {
      pointer(control, "pointerdown", input); pointer(control, "pointerup", input); fireEvent.click(control, { detail: 1 });
      expect(first.getAttribute("aria-selected")).toBe("true");
    }
    const second = screen.getByRole("button", { name: "second" });
    pointer(second, "pointerdown", input); pointer(second, "pointerup", input); fireEvent.click(second, { detail: 1 });
    expect(first.getAttribute("aria-selected")).toBe("false"); expect(second.getAttribute("aria-selected")).toBe("true");
    pointer(second, "pointerdown", input); pointer(second, "pointerup", input); fireEvent.click(second, { detail: 1 });
    expect(opened).toHaveBeenCalledExactlyOnceWith("second");
  });
});
