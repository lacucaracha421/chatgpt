import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MangaShelfRow, mangaShelfData, shelfEditionVolumes } from "./MangaShelfRow";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
const volume = (id: string, volumeNumber: number, editionIndex = 0) => ({ id, volumeNumber, editionIndex, displayLabel: String(volumeNumber), coverArtworkId: `art-${id}`, localReleaseDate: null, isbn13: null, releaseStatus: "released" as const });

describe("manga shelf row", () => {
  it("shows the 기본판 (else the first edition) in volume order and marks volumes past the owned count", () => {
    expect(shelfEditionVolumes([volume("b", 2), volume("x", 1, 1), volume("a", 1)]).map(item => item.id)).toEqual(["a", "b"]);
    expect(shelfEditionVolumes([volume("y", 2, 2), volume("x", 1, 1)]).map(item => item.id)).toEqual(["x"]);
    const data = mangaShelfData([volume("a", 1), volume("b", 2)], [], 1, "b");
    expect(data.ownedNumbers).toEqual([1]);
    expect(data.activeVolumeId).toBe("b");
    expect(mangaShelfData([], [], null, null).ownedNumbers).toBeNull();
  });

  it("asks for its volumes only once it comes near the visible list", () => {
    const observers: { callback: IntersectionObserverCallback; options?: IntersectionObserverInit }[] = [];
    vi.stubGlobal("IntersectionObserver", class {
      constructor(callback: IntersectionObserverCallback, options?: IntersectionObserverInit) { observers.push({ callback, options }); }
      observe() {} disconnect() {} unobserve() {} takeRecords() { return []; }
    });
    const onNear = vi.fn();
    const { container } = render(<div style={{ overflowY: "auto" }} className="scroller"><MangaShelfRow id="m1" title="다이의 대모험" owned={null} manga={null} privacy={false} coverUrl={() => null}
      onNear={onNear} onPick={() => undefined} onOpen={() => undefined} /></div>);
    expect(onNear).not.toHaveBeenCalled();
    expect(container.querySelector(".manga-shelf-row__waiting .manga-bookcase-board")).not.toBeNull();
    expect(observers[0].options?.root).toBe(container.querySelector(".scroller"));
    observers[0].callback([{ isIntersecting: true } as IntersectionObserverEntry], {} as IntersectionObserver);
    expect(onNear).toHaveBeenCalledOnce();
  });

  it("opens the work at the picked volume on Enter and from its title", () => {
    const onOpen = vi.fn(), onPick = vi.fn();
    render(<MangaShelfRow id="m1" title="다이의 대모험" owned={2} manga={mangaShelfData([volume("a", 1), volume("b", 2)], [], 2, "b")} privacy={false} coverUrl={id => `thumb:${id}`}
      onNear={() => undefined} onPick={onPick} onOpen={onOpen} />);
    fireEvent.keyDown(screen.getByRole("button", { name: "1권 보기" }), { key: "Enter" });
    expect(onOpen).not.toHaveBeenCalled();
    fireEvent.keyDown(screen.getByRole("button", { name: "2권 보기" }), { key: "Enter" });
    expect(onOpen).toHaveBeenLastCalledWith("b");
    fireEvent.click(screen.getByRole("button", { name: "1권 보기" }));
    expect(onPick).toHaveBeenLastCalledWith("a");
    fireEvent.click(screen.getByRole("button", { name: "다이의 대모험" }));
    expect(onOpen).toHaveBeenLastCalledWith(null);
    expect(screen.getByLabelText("보유 2권 / 전체 2권")).toHaveTextContent("2 / 2권");
  });
  it("asks for the work's action sheet on a long press of its row and swallows the click that follows", () => {
    vi.useFakeTimers();
    try {
      const onLongPress = vi.fn(), onPick = vi.fn();
      render(<MangaShelfRow id="m1" title="다이의 대모험" owned={2} manga={mangaShelfData([volume("a", 1), volume("b", 2)], [], 2, null)} privacy={false} coverUrl={id => `thumb:${id}`}
        onNear={() => undefined} onPick={onPick} onOpen={() => undefined} onLongPress={onLongPress} />);
      const spine = screen.getByRole("button", { name: "1권 보기" });
      fireEvent.pointerDown(spine, { button: 0, clientX: 30, clientY: 30 });
      act(() => { vi.advanceTimersByTime(450); });
      fireEvent.pointerUp(spine, { button: 0 });
      expect(onLongPress).toHaveBeenCalledOnce();
      fireEvent.click(spine);
      expect(onPick).not.toHaveBeenCalled();
      fireEvent.click(spine);
      expect(onPick).toHaveBeenCalledWith("a");
    } finally { vi.useRealTimers(); }
  });
});
