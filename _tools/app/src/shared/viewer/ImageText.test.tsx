import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { ImageTextSection } from "./ImageTextSection";
import { ImageTextMarkers, imageTextMarkerPositions } from "./ImageTextMarkers";
import type { ImageTextLine } from "../../library/types";

afterEach(cleanup);
const lines: ImageTextLine[] = [
  { original: "ねえ", korean: "있잖아", box: { x0: 0, y0: 0, x1: 200, y1: 200 } },
  { original: "はい", korean: "응", box: { x0: 0, y0: 0, x1: 200, y1: 200 } },
  { original: "終", korean: "끝" },
];

it("uses a whole-row fold button and numbered Korean/original rows with muted unpositioned numbers", () => {
  const onToggle = vi.fn();
  const onSelect = vi.fn();
  const { container, rerender } = render(<ImageTextSection lines={lines} selected={null} open={false} onSelect={onSelect} onToggle={onToggle} />);
  expect(screen.getByRole("button", { name: /번역.*3줄/ })).toHaveAttribute("aria-expanded", "false");
  expect(container.querySelector(".ui-fold")).toHaveAttribute("inert");
  expect(screen.queryByRole("button", { name: /있잖아/ })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: /번역.*3줄/ }));
  expect(onToggle).toHaveBeenCalledOnce();
  rerender(<ImageTextSection lines={lines} selected={1} open onSelect={onSelect} onToggle={onToggle} />);
  expect(screen.getByRole("button", { name: /응.*はい/ })).toHaveAttribute("aria-pressed", "true");
  fireEvent.click(screen.getByRole("button", { name: /있잖아.*ねえ/ }));
  expect(onSelect).toHaveBeenCalledWith(0);
  expect(container.querySelectorAll('[data-positioned="false"]')).toHaveLength(1);
});

it("scrolls the selected row inside the designated reading surface only", () => {
  const { container, rerender } = render(<div data-image-text-scroll><ImageTextSection lines={lines} selected={null} open onSelect={vi.fn()} onToggle={vi.fn()} /></div>);
  const dock = container.firstElementChild as HTMLElement;
  const row = container.querySelector('[data-line="1"]')!;
  vi.spyOn(dock, "getBoundingClientRect").mockReturnValue({ top: 0, bottom: 100 } as DOMRect);
  vi.spyOn(row, "getBoundingClientRect").mockReturnValue({ top: 120, bottom: 180 } as DOMRect);
  rerender(<div data-image-text-scroll><ImageTextSection lines={lines} selected={1} open onSelect={vi.fn()} onToggle={vi.fn()} /></div>);
  expect(dock.scrollTop).toBe(80);
});

it("anchors at top-left plus half a badge, nudges overlaps and clamps at every image edge", () => {
  expect(imageTextMarkerPositions(lines, 100, 100)).toEqual([{ index: 0, x: 10, y: 10 }, { index: 1, x: 10, y: 34 }]);
  expect(imageTextMarkerPositions(lines, 100, 100, 2)).toEqual([{ index: 0, x: 5, y: 5 }, { index: 1, x: 5, y: 17 }]);
  const outside = [{ original: "a", korean: "a", box: { x0: 1100, y0: -100, x1: 1200, y1: 0 } }];
  expect(imageTextMarkerPositions(outside, 100, 100)).toEqual([{ index: 0, x: 90, y: 10 }]);
});

it("renders only positioned markers, counter-scales and hides folded markers from interaction", () => {
  const select = vi.fn();
  const props = { lines, selected: 1, onSelect: select, rect: { left: 10, top: 20, width: 100, height: 100 }, zoom: { scale: 2, x: 30, y: 40 } };
  const { container, rerender } = render(<ImageTextMarkers {...props} open />);
  expect(screen.getAllByRole("button")).toHaveLength(2);
  expect(screen.getByRole("button", { name: "1번 대사" })).toHaveAttribute("data-muted", "true");
  expect(screen.getByRole("button", { name: "2번 대사" })).toHaveAttribute("aria-pressed", "true");
  expect(screen.getByRole("button", { name: "2번 대사" }).style.transform).toContain("scale(0.5)");
  fireEvent.click(screen.getByRole("button", { name: "1번 대사" }));
  expect(select).toHaveBeenCalledWith(0);
  rerender(<ImageTextMarkers {...props} open={false} />);
  expect(screen.queryByRole("button")).toBeNull();
  expect(container.firstElementChild).toHaveAttribute("inert");
});

it("leaves pointer taps to the surface while retaining marker keyboard activation", () => {
  const onSelect = vi.fn();
  const {container} = render(<ImageTextMarkers lines={lines} selected={null} open onSelect={onSelect} rect={{left:0,top:0,width:400,height:600}} zoom={{scale:1,x:0,y:0}} surfaceTap size={24}/>);
  const marker = screen.getByRole("button", {name:"1번 대사"});
  expect(container.firstElementChild).toHaveAttribute("data-surface-tap", "true");
  fireEvent.click(marker, {detail:1});
  expect(onSelect).not.toHaveBeenCalled();
  fireEvent.click(marker, {detail:0});
  expect(onSelect).toHaveBeenCalledWith(0);
});
