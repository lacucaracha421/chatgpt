import { readFileSync } from "node:fs";
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { MangaBookcase, type MangaWorkData } from "./MangaBookcase";

const css = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");
const shared = css("../../styles/tokens.css") + css("../../styles/controls.css") + css("../mangaConnections.css") + css("./collectionWork.css");
afterEach(() => { cleanup(); document.head.querySelectorAll("[data-layout-test]").forEach(style => style.remove()); });
function styles(mobile: boolean) {
  const style = document.createElement("style"); style.dataset.layoutTest = "";
  // Deliberately load provider CSS last, as the real dock can receive it through lazy imports.
  style.textContent = shared + (mobile ? css("../../../mobile-client/collectionShelf.css") : "") + css("../mangaConnections.css");
  document.head.append(style);
}
function data(count: number): MangaWorkData {
  return { volumes: Array.from({ length: count }, (_, i) => ({ id: `v${i + 1}`, volumeNumber: i + 1, editionIndex: 0, displayLabel: `${i + 1}`, coverArtworkId: null, localReleaseDate: null, isbn13: null, releaseStatus: null })), activeVolumeId: "v1", editionIndex: 0, focuses: [], ownedNumbers: null, scope: "", revision: "", ownership: null, management: null };
}
// jsdom checks the real CSS cascade and sizing contract; actual scrolling/layout needs a browser.
describe.each([false, true])("shared manga shelf CSS (tablet: %s)", mobile => {
  it.each([3, 37])("keeps %i volumes on a nonshrinking board and centres short detail shelves", count => {
    styles(mobile);
    const { container } = render(<div className={mobile ? "tablet-work tablet-work--manga" : "work-surface"}><MangaBookcase manga={data(count)} privacy={false} onPick={() => undefined} /></div>);
    const board = getComputedStyle(container.querySelector(".manga-bookcase-board")!);
    expect(board.flexShrink).toBe("0"); expect(board.width).toBe("max-content"); expect(board.minWidth).toBe("100%");
    expect(getComputedStyle(container.querySelector(".manga-bookcase-spines")!).justifyContent).toBe("center");
    expect(container.querySelector('[data-volume-id="v1"]')).not.toBeNull();
    expect(container.querySelector(`[data-volume-id="v${count}"]`)).not.toBeNull();
  });
  it("reserves a separate 184px row for 120px books, padding and the picked number", () => {
    styles(mobile);
    const { container } = render(<div className={mobile ? "tablet-work tablet-work--manga" : "work-surface"}><div className="work-stage manga-work-stage" /><MangaBookcase manga={data(37)} privacy={false} onPick={() => undefined} /></div>);
    const shelf = getComputedStyle(container.querySelector(".manga-bookcase")!);
    const board = getComputedStyle(container.querySelector(".manga-bookcase-board")!);
    const track = getComputedStyle(container.querySelector(".home-shelf__track")!);
    const tokens = getComputedStyle(document.documentElement);
    const padding = parseFloat(tokens.getPropertyValue("--space-8"));
    expect(track.boxSizing).toBe("border-box"); expect(track.height).toBe("100%");
    expect(parseFloat(shelf.height)).toBe(parseFloat(board.height) + 2 * padding);
    expect(padding).toBeGreaterThanOrEqual(parseFloat(tokens.getPropertyValue("--space-2")) + parseFloat(tokens.getPropertyValue("--line-meta")));
    if (!mobile) expect(getComputedStyle(container.querySelector(".manga-work-stage")!).bottom).toBe(shelf.height);
  });
});
it("keeps provider cards in one column inside the work dock at any window width", () => {
  styles(false);
  const { container } = render(<><aside className="work-dock"><div className="manga-connections__choices"><button>MangaDex</button><button>카카오</button></div></aside><div className="manga-connections__choices" /></>);
  expect(getComputedStyle(container.querySelector(".work-dock .manga-connections__choices")!).gridTemplateColumns).toBe("minmax(0, 1fr)");
  expect(getComputedStyle(container.lastElementChild!).gridTemplateColumns).toBe("repeat(2, minmax(0, 1fr))");
});

it('gives the PC object the freed strip height, including with the information dock open', () => {
  styles(false);
  const {container} = render(<div className="work-surface work-surface--info"><div className="work-stage"/><div className="work-strip"/></div>);
  const stage=container.querySelector('.work-stage')!;
  const strip=container.querySelector('.work-strip')!;
  // jsdom keeps inset as a shorthand; native geometry still needs a window check.
  expect(getComputedStyle(stage).getPropertyValue('inset')).toBe('0 0 76px');
  expect(getComputedStyle(strip).height).toBe('76px');
  expect(getComputedStyle(stage).right).toBe(getComputedStyle(strip).right);
  stage.classList.add('work-stage--no-strip');
  expect(getComputedStyle(stage).bottom).toBe('0px');
});
