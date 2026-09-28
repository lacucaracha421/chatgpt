import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useState } from "react";
import { SegmentedControl } from "./SegmentedControl";

type Choice = "one" | "two" | "three";
const options = [
  { value: "one", label: "One", count: 12 },
  { value: "two", label: "Two", count: 1_284 },
  { value: "three", label: "Three", count: 0 },
] as const;

function bounds(left: number, width: number): DOMRect {
  return { bottom: 44, height: 32, left, right: left + width, top: 12, width, x: left, y: 12, toJSON: () => ({}) } as DOMRect;
}

function mockLayout() {
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
    if (this.classList.contains("ui-segmented")) return bounds(100, 200);
    if (this.classList.contains("ui-segmented__cell")) {
      const cells = Array.from(this.parentElement?.querySelectorAll<HTMLButtonElement>(".ui-segmented__cell") ?? []);
      const index = cells.indexOf(this as HTMLButtonElement);
      const width = 64;
      return bounds(104 + index * width, width);
    }
    return bounds(0, 0);
  });
}

function Harness({ onChange }: { onChange: (value: Choice) => void }) {
  const [value, setValue] = useState<Choice>("one");
  return <SegmentedControl label="Choices" options={options} value={value} onChange={next => { setValue(next); onChange(next); }} />;
}

beforeEach(() => {
  mockLayout();
  vi.stubGlobal("ResizeObserver", class {
    observe() {}
    disconnect() {}
  });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("SegmentedControl", () => {
  it("renders counts and selects a cell on tap", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);

    expect(screen.getByRole("radio", { name: "Two 1,284" })).toBeInTheDocument();
    await user.click(screen.getByRole("radio", { name: "Two 1,284" }));

    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith("two");
    expect(screen.getByRole("radio", { name: "Two 1,284" })).toHaveAttribute("aria-checked", "true");
  });

  it("fires one change after dragging from cell 0 to cell 2", () => {
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    const track = screen.getByRole("radiogroup", { name: "Choices" });
    const first = screen.getByRole("radio", { name: "One 12" });
    const thumb = track.querySelector<HTMLElement>(".ui-segmented__thumb")!;

    fireEvent.pointerDown(first, { button: 0, pointerId: 1, clientX: 136 });
    fireEvent.pointerMove(track, { pointerId: 1, clientX: 200 });
    expect(thumb.style.left).toBe("68px");
    fireEvent.pointerMove(track, { pointerId: 1, clientX: 232 });
    expect(thumb.style.left).toBe("100px");
    fireEvent.pointerMove(track, { pointerId: 1, clientX: 264 });
    expect(screen.getByRole("radio", { name: "Three 0" })).toHaveAttribute("data-segmented-active", "true");
    fireEvent.pointerUp(track, { pointerId: 1, clientX: 264 });

    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith("three");
  });

  it("treats movement under six pixels as a tap", () => {
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    const track = screen.getByRole("radiogroup", { name: "Choices" });
    const second = screen.getByRole("radio", { name: "Two 1,284" });

    fireEvent.pointerDown(second, { button: 0, pointerId: 2, clientX: 200 });
    fireEvent.pointerMove(track, { pointerId: 2, clientX: 205 });
    fireEvent.pointerUp(track, { pointerId: 2, clientX: 205 });
    fireEvent.click(second, { detail: 1 });

    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith("two");
  });

  it("restores the current value when the pointer is cancelled", () => {
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    const track = screen.getByRole("radiogroup", { name: "Choices" });
    const first = screen.getByRole("radio", { name: "One 12" });

    fireEvent.pointerDown(first, { button: 0, pointerId: 3, clientX: 136 });
    fireEvent.pointerMove(track, { pointerId: 3, clientX: 264 });
    expect(screen.getByRole("radio", { name: "Three 0" })).toHaveAttribute("data-segmented-active", "true");
    fireEvent.pointerCancel(track, { pointerId: 3 });

    expect(onChange).not.toHaveBeenCalled();
    expect(screen.getByRole("radio", { name: "One 12" })).toHaveAttribute("data-segmented-active", "true");
  });

  it("keeps roving radio keyboard navigation", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    const first = screen.getByRole("radio", { name: "One 12" });

    first.focus();
    await user.keyboard("{ArrowRight}");

    await waitFor(() => expect(onChange).toHaveBeenCalledWith("two"));
    expect(screen.getByRole("radio", { name: "Two 1,284" })).toHaveFocus();
  });
});
