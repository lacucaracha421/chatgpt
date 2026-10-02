import { readFileSync } from "node:fs";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
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

it.each([false, true])("retains the book strip until its front loads and through put-down (reduced=%s)", async reduced => {
  vi.useFakeTimers(); motion(reduced);
  const props = { privacy: false, coverUrl: () => "/cover", onPick: vi.fn() };
  const view = render(<MangaBookcase {...props} manga={manga} />);
  const button = screen.getByRole("button", { name: "1권 보기" });
  const strip = button.querySelector(".manga-spine-strip");
  const image = strip?.querySelector("img");
  view.rerender(<MangaBookcase {...props} manga={{ ...manga, activeVolumeId: "v1" }} />);
  expect(button).toHaveAttribute("aria-pressed", "true");
  expect(button).not.toHaveClass("is-fronted");
  expect(strip?.querySelector("img")).toBe(image);
  expect(strip).not.toHaveStyle({ visibility: "hidden" });
  const front = button.querySelector(".manga-spine-front")!;
  await act(async () => { fireEvent.load(front.querySelector("img")!); });
  expect(button).toHaveClass("is-fronted");
  view.rerender(<MangaBookcase {...props} manga={manga} />);
  expect(button).not.toHaveClass("is-fronted");
  expect(strip?.querySelector("img")).toBe(image);
  if (reduced) expect(button.querySelector(".manga-spine-front")).toBeNull();
  else {
    expect(button.querySelector(".manga-spine-front")).toBe(front);
    expect(button).toHaveClass("is-settling");
    act(() => vi.advanceTimersByTime(420));
    expect(button.querySelector(".manga-spine-front")).toBeNull();
  }
});

it("keeps the old strip while a picked front decodes", async () => {
  motion(false);
  const view = render(<MangaBookcase manga={manga} privacy={false} coverUrl={() => "/decode-cover"} onPick={() => undefined} />);
  const button = screen.getByRole("button", { name: "1권 보기" });
  const strip = button.querySelector(".manga-spine-strip");
  view.rerender(<MangaBookcase manga={{ ...manga, activeVolumeId: "v1" }} privacy={false} coverUrl={() => "/decode-cover"} onPick={() => undefined} />);
  let decoded!: () => void;
  const image = button.querySelector<HTMLImageElement>(".manga-spine-front img")!;
  image.decode = vi.fn(() => new Promise<void>(resolve => { decoded = resolve; }));
  fireEvent.load(image);
  expect(button).not.toHaveClass("is-fronted");
  expect(button.querySelector(".manga-spine-strip")).toBe(strip);
  expect(strip).not.toHaveStyle({ visibility: "hidden" });
  await act(async () => decoded());
  expect(button).toHaveClass("is-fronted");
});

it("uses the exact shelf timing and disables it for reduced motion", () => {
  const cases = readFileSync("src/collections/case/LightCase.css", "utf8");
  const books = readFileSync("src/collections/work/collectionWork.css", "utf8");
  expect(cases).toContain("transition: transform 360ms var(--ease-sheet)");
  expect(cases).not.toMatch(/transition:[^;]*\bleft\b/);
  expect(cases).toContain("translateX(calc(var(--lead) * -1))");
  expect(cases).toMatch(/@media \(prefers-reduced-motion: reduce\).*\.cs-box, \.collection-light-case::after \{ transition: none;/s);
  expect(books).toContain("transition: transform 360ms var(--ease-sheet), opacity 360ms var(--ease-sheet)");
  expect(books).toMatch(/@media \(prefers-reduced-motion: reduce\) \{ \.manga-spine-front, \.manga-spine-strip \{ transition: none;/);
  const shortcuts = readFileSync("src/collections/CollectionBrowser.css", "utf8");
  expect(shortcuts).toMatch(/@media \(max-width: 1100px\) \{ \.collection-shortcuts__label \{ display: none;/);
  const tablet = readFileSync("mobile-client/collectionShelf.css", "utf8");
  expect(tablet).toContain("min-width: 44px; min-height: 44px");
  expect(tablet).toContain(".mobile-collections .collection-shortcuts__label { display: none; }");
});
