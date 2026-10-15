import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { ImageTextSection } from "./ImageTextSection";
import { ImageTextNotes, type ImageTextNotesHandle } from "./ImageTextNotes";
import { createRef } from "react";
import { act } from "@testing-library/react";
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

it("draws solid translated notes only for boxed lines, toggles them and raises the selected row", () => {
  const onSelect = vi.fn();
  const props = {lines, onSelect, rect: {left: 10, top: 20, width: 400, height: 600}, zoom: {scale: 2, x: 30, y: 40}};
  const {container, rerender} = render(<ImageTextNotes {...props} selected={null} open/>);
  expect(screen.getAllByRole("button")).toHaveLength(2);
  expect(screen.getByRole("button", {name: "1번 대사"})).toHaveTextContent("있잖아");
  expect(screen.queryByText("끝")).toBeNull();
  rerender(<ImageTextNotes {...props} selected={1} open/>);
  const note = screen.getByRole("button", {name: "2번 대사"});
  expect(note).toHaveAttribute("aria-pressed", "true");
  expect(Number(note.style.zIndex)).toBeGreaterThan(Number(screen.getByRole("button", {name: "1번 대사"}).style.zIndex));
  rerender(<ImageTextNotes {...props} selected={1} open={false}/>);
  expect(screen.queryByRole("button")).toBeNull();
  expect(container.firstElementChild).toHaveAttribute("inert");
});

it("opens an original/translation card, copies the translation and reports a copy failure", async () => {
  const onCopy = vi.fn().mockResolvedValue(undefined);
  render(<ImageTextNotes lines={lines} selected={null} open onSelect={vi.fn()} rect={{left:0,top:0,width:400,height:600}} zoom={{scale:1,x:0,y:0}} onCopy={onCopy}/>);
  fireEvent.click(screen.getByRole("button", {name: "1번 대사"}));
  expect(screen.getByRole("region", {name: "대사 번역"})).toHaveTextContent("ねえ있잖아");
  await act(async () => fireEvent.click(screen.getByRole("button", {name: "복사"})));
  expect(onCopy).toHaveBeenCalledWith("있잖아");
  expect(screen.getByRole("status")).toHaveTextContent("복사됨");
  onCopy.mockRejectedValue(new Error("denied"));
  await act(async () => fireEvent.click(screen.getByRole("button", {name: "복사"})));
  expect(screen.getByRole("status")).toHaveTextContent("복사하지 못했습니다");
  const escape = new KeyboardEvent("keydown", {key:"Escape", bubbles:true, cancelable:true});
  fireEvent(screen.getByRole("region"), escape);
  expect(escape.defaultPrevented).toBe(true);
  expect(screen.queryByRole("region")).toBeNull();
});

it("holds layout through zoom/pan, transforms the previous notes and refits at screen size on settle", () => {
  const props = {lines, selected:null, open:true, onSelect:vi.fn(), rect:{left:0,top:0,width:400,height:600}};
  const {container, rerender} = render(<ImageTextNotes {...props} zoom={{scale:1,x:0,y:0}}/>);
  const note = screen.getByRole("button", {name:"1번 대사"});
  const width = note.style.width;
  rerender(<ImageTextNotes {...props} zoom={{scale:2,x:30,y:40}} panning/>);
  expect(note.style.width).toBe(width);
  expect((container.firstElementChild as HTMLElement).style.transform).toContain("scale(2)");
  expect(container.firstElementChild).not.toHaveAttribute("inert");
  rerender(<ImageTextNotes {...props} zoom={{scale:2,x:30,y:40}}/>);
  expect((container.firstElementChild as HTMLElement).style.transform).toContain("scale(1)");
  expect(parseFloat(note.style.fontSize)).toBeGreaterThanOrEqual(14);
});

it("routes touch taps through the surface hit test and retains keyboard activation", () => {
  const ref = createRef<ImageTextNotesHandle>();
  const onSelect = vi.fn();
  const {container} = render(<ImageTextNotes ref={ref} lines={[lines[0]]} selected={null} open onSelect={onSelect} rect={{left:0,top:0,width:400,height:600}} zoom={{scale:1,x:0,y:0}} surfaceTap/>);
  const note = screen.getByRole("button", {name:"1번 대사"});
  expect(container.firstElementChild).toHaveAttribute("data-surface-tap", "true");
  act(() => expect(ref.current?.tap(parseFloat(note.style.left)+2,parseFloat(note.style.top)+2)).toBe(true));
  expect(onSelect).toHaveBeenCalledWith(0);
  expect(screen.getByRole("region")).toBeTruthy();
  expect(ref.current?.tap(390,590)).toBe(false);
  fireEvent.click(note, {detail:0});
  expect(onSelect).toHaveBeenCalledTimes(2);
});
