import { readFileSync } from "node:fs";
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { LightCase } from "./case/LightCase";
import { MangaBookcase, type MangaWorkData } from "./work/MangaBookcase";

const data = { title: "Game", platform: "pc" as const, front: null, spine: null, privacy: false };
const manga: MangaWorkData = {
  volumes: [{ id: "v1", volumeNumber: 1, editionIndex: 0, displayLabel: "1", coverArtworkId: "a1", localReleaseDate: null, isbn13: null, releaseStatus: "released" }],
  activeVolumeId: null, editionIndex: 0, focuses: [], ownedNumbers: null, scope: "", revision: "", ownership: null, management: null,
};
afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
function motion(reduced: boolean) {
  vi.stubGlobal("matchMedia", () => ({ matches: reduced }));
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => { callback(0); return 1; });
}

it.each([false, true])("retains the same case on pick and put-down (reduced=%s)", reduced => {
  vi.useFakeTimers(); motion(reduced);
  const view = render(<LightCase data={data} selected={false} />);
  const box = view.container.querySelector(".cs-box");
  view.rerender(<LightCase data={data} selected />);
  expect(box?.parentElement).toHaveAttribute("data-front");
  view.rerender(<LightCase data={data} selected={false} />);
  expect(view.container.querySelector(".cs-box")).toBe(box);
  expect(box?.parentElement).not.toHaveAttribute("data-front");
  expect(box?.parentElement?.hasAttribute("data-settling")).toBe(!reduced);
  act(() => vi.advanceTimersByTime(420));
  expect(box?.parentElement).not.toHaveAttribute("data-settling");
});

it("paints the selected case above a later neighbour that is still settling", () => {
  vi.useFakeTimers(); motion(false);
  const style = document.createElement("style");
  style.textContent = readFileSync("src/collections/collectionShelfRules.css", "utf8");
  document.head.append(style);
  try {
    const draw = (selected: number) => <div className="collection-list collection-list--shelf">{[0, 1].map(index =>
      <div key={index} className="collection-list__cell"><button className="collection-card" aria-selected={selected === index}>
        <LightCase data={{ ...data, platform: "book" }} selected={selected === index} />
      </button></div>)}</div>;
    const { container, rerender } = render(draw(1));
    rerender(draw(0));
    const cells = container.querySelectorAll<HTMLElement>(".collection-list__cell");
    expect(cells[1].querySelector("[data-settling]")).not.toBeNull();
    expect(Number(getComputedStyle(cells[0]).zIndex)).toBeGreaterThan(Number(getComputedStyle(cells[1]).zIndex));
  } finally { style.remove(); }
});

it("lifts the selected case toward the viewer and lowers it again", () => {
  vi.useFakeTimers(); motion(false);
  const style = document.createElement("style");
  // LightCase.css is the case's own stylesheet on both clients; its @import is the shared paint order.
  style.textContent = readFileSync("src/collections/case/LightCase.css", "utf8").replace(/^@import[^\n]*\n/, "");
  document.head.append(style);
  try {
    const view = render(<LightCase data={data} selected={false} />);
    const box = view.container.querySelector<HTMLElement>(".cs-box")!;
    const resting = getComputedStyle(box).transform;
    expect(resting).toContain("rotateY(34deg)");
    view.rerender(<LightCase data={data} selected />);
    expect(getComputedStyle(box).transform).toContain("translateZ(34px)");
    expect(getComputedStyle(box).transform).not.toBe(resting);
    view.rerender(<LightCase data={data} selected={false} />);
    expect(getComputedStyle(box).transform).toBe(resting);
  } finally { style.remove(); }
});

it("keeps the PC pick transition when tablet shelf overrides are also loaded", () => {
  vi.useFakeTimers(); motion(false);
  const style = document.createElement("style");
  style.textContent = ["src/collections/case/LightCase.css", "src/collections/CollectionBrowser.css", "mobile-client/collectionShelf.css"]
    .map(path => readFileSync(path, "utf8").replace(/^@import[^\n]*\n/gm, "")).join("\n");
  document.head.append(style);
  try {
    // Even a cell with the tablet's class must keep PC motion outside mobile-collections.
    const draw = (selected: boolean) => <div className="collection-browser"><div className="collection-list collection-list--shelf">
      <div className="collection-list__cell collection-cover-cell"><button className="collection-card" aria-selected={selected}>
        <LightCase data={data} selected={selected} />
      </button></div>
    </div></div>;
    const view = render(draw(false));
    const box = view.container.querySelector<HTMLElement>(".cs-box")!;
    const transition = getComputedStyle(box).transition;
    expect(transition).toContain("transform 360ms");
    view.rerender(draw(true));
    expect(view.container.querySelector(".cs-box")).toBe(box);
    expect(getComputedStyle(box).transition).toBe(transition);
    expect(getComputedStyle(box).transform).toContain("translateZ(34px)");
    view.rerender(draw(false));
    expect(getComputedStyle(box).transition).toBe(transition);
    expect(getComputedStyle(box).transform).toContain("rotateY(34deg)");
  } finally { style.remove(); }
});

it.each([false, true])("swaps a painted book with its retained slot on put-back (reduced=%s)", async reduced => {
  vi.useFakeTimers(); motion(reduced);
  const view = render(<MangaBookcase manga={manga} privacy={false} coverUrl={() => "/cover"} onPick={vi.fn()} />);
  const button = view.container.querySelector<HTMLElement>("[data-volume-id]")!;
  const strip = button.querySelector(".manga-spine-strip");
  fireEvent.click(button);
  const out = document.querySelector<HTMLElement>(".manga-shelf-out")!;
  if (!reduced) {
    expect(button).not.toHaveAttribute("data-out");
    expect(out).toHaveClass("is-preparing");
  }
  await act(async () => { fireEvent.load(out.querySelector(".paperback-front img")!); });
  expect(button).toHaveAttribute("data-out");
  expect(button.querySelector(".manga-spine-strip")).toBe(strip);
  fireEvent.keyDown(window, { key: "Escape" });
  if (!reduced) {
    expect(out).toHaveClass("is-leaving");
    expect(button).toHaveAttribute("data-out");
    act(() => vi.advanceTimersByTime(440));
  }
  expect(document.querySelector(".manga-shelf-out")).toBeNull();
  expect(button).not.toHaveAttribute("data-out");
  expect(button.querySelector(".manga-spine-strip")).toBe(strip);
});

it("caps preparation and cancels an unpainted pick without hiding the spine", () => {
  vi.useFakeTimers(); motion(false);
  const view = render(<MangaBookcase manga={manga} privacy={false} coverUrl={() => "/slow"} onPick={vi.fn()} />);
  const button = view.container.querySelector<HTMLElement>("[data-volume-id]")!;
  fireEvent.click(button);
  fireEvent.keyDown(window, { key: "Escape" });
  expect(document.querySelector(".manga-shelf-out")).toBeNull();
  expect(button).not.toHaveAttribute("data-out");
  fireEvent.click(button);
  act(() => vi.advanceTimersByTime(350));
  expect(button).toHaveAttribute("data-out");
  fireEvent.click(document.body);
  expect(document.querySelector(".manga-shelf-out")).toHaveClass("is-leaving");
  act(() => vi.advanceTimersByTime(440));
  expect(button).not.toHaveAttribute("data-out");
});

it("opens a held book by click, suppresses the end of a drag, and permits a later tap", () => {
  motion(true);
  const open = vi.fn();
  const view = render(<MangaBookcase list manga={manga} privacy onPick={vi.fn()} onEnlarge={open} />);
  fireEvent.click(view.container.querySelector("[data-volume-id]")!);
  const book = document.querySelector<HTMLElement>(".manga-shelf-out .kase")!;
  function pointer(type: string, x: number) {
    const event = new MouseEvent(type, { bubbles: true, clientX: x, button: 0 });
    Object.defineProperties(event, { pointerId: { value: 1 }, pointerType: { value: "touch" } });
    fireEvent(book, event);
  }
  pointer("pointerdown", 50); pointer("pointermove", 220); pointer("pointerup", 220);
  fireEvent.click(book);
  expect(open).not.toHaveBeenCalled();
  pointer("pointerdown", 220); pointer("pointerup", 220);
  fireEvent.click(book);
  expect(open).toHaveBeenCalledExactlyOnceWith("v1");
  expect(document.querySelector(".manga-shelf-out")).toBeNull();
});

it.each(["Enter", " "])("pulls with %s and selects a work-screen volume only from the held book", key => {
  motion(true);
  const pick = vi.fn(), enlarge = vi.fn();
  const view = render(<MangaBookcase manga={manga} privacy onPick={pick} onEnlarge={enlarge} />);
  fireEvent.keyDown(view.container.querySelector("[data-volume-id]")!, {key});
  expect(document.querySelector(".manga-shelf-out .kase")).toHaveFocus();
  expect(pick).not.toHaveBeenCalled();
  fireEvent.keyDown(document.querySelector(".manga-shelf-out .kase")!, {key: "Enter"});
  expect(pick).toHaveBeenCalledExactlyOnceWith("v1");
  expect(enlarge).not.toHaveBeenCalled();
  expect(document.querySelector(".manga-shelf-out")).toBeNull();
});

it("puts a held volume back before pulling another from the same row", () => {
  vi.useFakeTimers(); motion(false);
  const volumes = [manga.volumes[0], {...manga.volumes[0], id: "v2", volumeNumber: 2}];
  const view = render(<MangaBookcase manga={{...manga, volumes}} privacy onPick={vi.fn()} />);
  const buttons = view.container.querySelectorAll("[data-volume-id]");
  fireEvent.click(buttons[0]);
  act(() => vi.advanceTimersByTime(350));
  fireEvent.click(buttons[1]);
  expect(document.querySelectorAll(".manga-shelf-out")).toHaveLength(1);
  expect(document.querySelector(".manga-shelf-out")).toHaveClass("is-leaving");
  act(() => vi.advanceTimersByTime(440));
  expect(document.querySelectorAll(".manga-shelf-out")).toHaveLength(1);
  expect(buttons[0]).not.toHaveAttribute("data-out");
  act(() => vi.advanceTimersByTime(350));
  expect(buttons[1]).toHaveAttribute("data-out");
});
