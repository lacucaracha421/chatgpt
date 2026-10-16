import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { CasePlatform } from "./case/CollectionCase";
import { SpineShelf, type SpineWork } from "./SpineShelf";

afterEach(() => { cleanup(); vi.restoreAllMocks(); });
const work = (index: number, platform: CasePlatform = "pc", extra: Partial<SpineWork> = {}): SpineWork => ({ id: `w${index}`, platform, title: `작품 ${index}`, credit: "회사", developer: "회사", front: `/front-${index}`, spine: null, pending: false, ...extra });
const list = (count: number, platform: CasePlatform = "pc") => Array.from({ length: count }, (_, index) => work(index, platform));

function Shelf({ works, onOpen = () => undefined, touchTargets = false }: { works: SpineWork[]; onOpen?(id: string): void; touchTargets?: boolean }) {
  const [picked, setPicked] = useState<string | null>(null);
  // The browser's scroll area is what the shelf measures.
  return <div className="collection-browser__list-scroll" data-testid="scroll">
    <SpineShelf groups={[{ label: "", works }]} scale={1.1} label="작품 목록" pickedId={picked} onPick={setPicked} onOpen={onOpen} touchTargets={touchTargets} />
  </div>;
}
const spine = (title: string) => screen.getByRole("button", { name: new RegExp(`^${title} ·`) });
const pressed = (title: string) => spine(title).getAttribute("aria-pressed");

beforeEach(() => {
  // An 800px tall scroll area whose content starts at its top: the host's rectangle follows the scroll offset.
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockImplementation(function(this: HTMLElement) { return this.classList.contains("collection-browser__list-scroll") ? 800 : 0; });
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function(this: HTMLElement) {
    const root = this.closest<HTMLElement>(".collection-browser__list-scroll");
    const top = this.classList.contains("spine-shelf") && root ? -root.scrollTop : 0;
    return { top, bottom: top, left: 0, right: 0, width: 0, height: 0, x: 0, y: top, toJSON() {} };
  });
});

it("pulls a case out on the first click, opens on the second, and puts it back on Esc", () => {
  const onOpen = vi.fn();
  render(<Shelf works={list(6)} onOpen={onOpen} />);
  fireEvent.click(spine("작품 2"));
  expect(pressed("작품 2")).toBe("true");
  expect(onOpen).not.toHaveBeenCalled();
  const out = document.querySelector<HTMLElement>(".spine-shelf__out")!;
  expect(out.dataset.id).toBe("w2");
  expect(out.querySelector("img")).toHaveAttribute("src", "/front-2");
  fireEvent.click(out);
  expect(onOpen).toHaveBeenCalledTimes(1);
  expect(onOpen).toHaveBeenCalledWith("w2");
  fireEvent.keyDown(spine("작품 2"), { key: "Escape" });
  expect(pressed("작품 2")).toBe("false");
});

it("opens with Enter on a picked case and picks with Enter on a resting one", () => {
  const onOpen = vi.fn();
  render(<Shelf works={list(4)} onOpen={onOpen} />);
  spine("작품 1").focus();
  fireEvent.keyDown(spine("작품 1"), { key: "Enter" });
  expect(pressed("작품 1")).toBe("true");
  expect(onOpen).not.toHaveBeenCalled();
  fireEvent.keyDown(spine("작품 1"), { key: "Enter" });
  expect(onOpen).toHaveBeenCalledTimes(1);
  expect(onOpen).toHaveBeenCalledWith("w1");
});

it("puts the case back when the empty shelf is clicked, and keeps only one case out", () => {
  render(<Shelf works={list(4)} />);
  fireEvent.click(spine("작품 0"));
  fireEvent.click(spine("작품 3"));
  expect(pressed("작품 0")).toBe("false");
  expect(pressed("작품 3")).toBe("true");
  fireEvent.click(screen.getByRole("group", { name: "작품 목록" }));
  expect(pressed("작품 3")).toBe("false");
});

it("moves with the arrow keys across rows and picks the case it lands on", async () => {
  // 80 DVD cases (15px + 1px seam) in the 912px of a 960px shelf: 57 on the first row, 23 on the second.
  render(<Shelf works={list(80)} />);
  spine("작품 3").focus();
  fireEvent.keyDown(spine("작품 3"), { key: "ArrowRight" });
  await waitFor(() => expect(document.activeElement).toBe(spine("작품 4")));
  expect(pressed("작품 4")).toBe("true");
  fireEvent.keyDown(spine("작품 4"), { key: "ArrowDown" });
  await waitFor(() => expect(document.activeElement).toBe(spine("작품 61")));
  fireEvent.keyDown(spine("작품 61"), { key: "ArrowUp" });
  await waitFor(() => expect(document.activeElement).toBe(spine("작품 4")));
  fireEvent.keyDown(spine("작품 4"), { key: "End" });
  await waitFor(() => expect(document.activeElement).toBe(spine("작품 56")));
  fireEvent.keyDown(spine("작품 56"), { key: "Home" });
  await waitFor(() => expect(document.activeElement).toBe(spine("작품 0")));
  // Only the focused case is a tab stop.
  expect(screen.getAllByRole("button").filter(button => button.getAttribute("tabindex") === "0")).toHaveLength(1);
});

it("on a touch screen a tap anywhere in a row picks the nearest case", () => {
  render(<Shelf works={list(6)} touchTargets />);
  const row = document.querySelector<HTMLElement>("[data-shelf-row]")!;
  vi.spyOn(row, "getBoundingClientRect").mockReturnValue({ left: 100, right: 1000, top: 0, bottom: 300, width: 900, height: 300, x: 100, y: 0, toJSON() {} });
  // The 4th spine spans 48-63px of the row; a tap on its seam-side edge, 56px in, is nearest to it and not to the 5th.
  fireEvent.click(row, { clientX: 100 + 56 });
  expect(pressed("작품 3")).toBe("true");
});

it("keeps a spine plastic-only while its artwork is pending, at its final size", () => {
  const { rerender } = render(<Shelf works={[work(0, "sw2", { pending: true }), work(1, "sw2")]} />);
  expect(spine("작품 0").querySelector(".ins")).toBeNull();
  expect(spine("작품 1").querySelector(".ins")).not.toBeNull();
  expect(spine("작품 0").style.getPropertyValue("--w")).toBe(spine("작품 1").style.getPropertyValue("--w"));
  rerender(<Shelf works={[work(0, "sw2"), work(1, "sw2")]} />);
  expect(spine("작품 0").querySelector(".ins")).not.toBeNull();
});

it("hides spines and the pulled-out cover in privacy mode", () => {
  render(<div className="collection-browser__list-scroll"><SpineShelf groups={[{ label: "", works: [work(0, "pc", { spine: "/spine-0" })] }]} scale={1.1} label="작품 목록" pickedId="w0" onPick={() => undefined} onOpen={() => undefined} privacy /></div>);
  expect(document.querySelector(".spine .case-mask")).not.toBeNull();
  expect(document.querySelector(".spine img")).toBeNull();
  expect(document.querySelector(".spine-shelf__out .case-mask")).not.toBeNull();
  expect(document.querySelector(".spine-shelf__out img")).toBeNull();
});

it("mounts only a window of rows for a large shelf and follows the scroll", async () => {
  render(<Shelf works={list(1000)} />);
  const mountedAtTop = screen.getAllByRole("button").length;
  expect(mountedAtTop).toBeGreaterThan(0);
  expect(mountedAtTop).toBeLessThan(500);
  expect(screen.queryByRole("button", { name: /^작품 999 ·/ })).toBeNull();
  const scroll = screen.getByTestId("scroll");
  // 1000 cases make 18 rows of 255px; scrolling to the bottom mounts the last rows and lets go of the middle ones.
  scroll.scrollTop = 4000;
  act(() => { fireEvent.scroll(scroll); });
  await waitFor(() => expect(screen.queryByRole("button", { name: /^작품 999 ·/ })).not.toBeNull());
  expect(screen.queryByRole("button", { name: /^작품 300 ·/ })).toBeNull();
  expect(within(screen.getByRole("group", { name: "작품 목록" })).getAllByRole("button").length).toBeLessThan(600);
});
