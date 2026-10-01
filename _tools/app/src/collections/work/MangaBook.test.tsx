import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MangaBook } from "./MangaBook";
import { MangaBookcase, type MangaWorkData } from "./MangaBookcase";
import { stripPosition } from "./coverStrip";

afterEach(() => { cleanup(); vi.restoreAllMocks(); });
const props = { src: "/cover", title: "위치 WATCH", author: "작가 이름", volumeNumber: 2, volumeTitle: "2권", focus: null, privacy: false, frontReset: 0, onReady: vi.fn() };
describe("turnable manga book", () => {
  it("rests facing front, rotates in 15 degree steps, and resets by Home or the front action", () => {
    const view = render(<MangaBook {...props} />); const book = screen.getByRole("group", { name: "책" });
    expect(book).toHaveAttribute("data-angle", "0");
    fireEvent.keyDown(book, { key: "ArrowRight" }); expect(book).toHaveAttribute("data-angle", "15");
    fireEvent.keyDown(book, { key: "ArrowLeft" }); expect(book).toHaveAttribute("data-angle", "0");
    fireEvent.keyDown(book, { key: "ArrowLeft" }); expect(book).toHaveAttribute("data-angle", "-15");
    fireEvent.keyDown(book, { key: "Home" }); expect(book).toHaveAttribute("data-angle", "0");
    fireEvent.keyDown(book, { key: "ArrowRight" });
    view.rerender(<MangaBook {...props} frontReset={1} />); expect(book).toHaveAttribute("data-angle", "0");
  });
  it("rotates through the back by drag, stops on release, and never toggles on a click", () => {
    render(<MangaBook {...props} />); const book = screen.getByRole("group", { name: "책" });
    fireEvent.pointerDown(book, { button: 0, pointerId: 1, clientX: 100 });
    fireEvent.pointerUp(book, { pointerId: 1, clientX: 100 }); fireEvent.click(book);
    expect(book).toHaveAttribute("data-angle", "0"); expect(book).not.toHaveAttribute("aria-expanded");
    fireEvent.pointerDown(book, { button: 0, pointerId: 1, clientX: 100 });
    fireEvent.pointerMove(book, { pointerId: 1, clientX: 420 });
    expect(book).toHaveAttribute("data-angle", "192"); expect(book).toHaveClass("is-dragging");
    expect(document.activeElement).toBe(book);
    fireEvent.pointerUp(book, { pointerId: 1 }); fireEvent.pointerMove(book, { pointerId: 1, clientX: 500 });
    expect(book).toHaveAttribute("data-angle", "192"); expect(book).not.toHaveClass("is-dragging");
    fireEvent.keyDown(book, { key: "Enter" }); fireEvent.keyDown(book, { key: " " });
    expect(book).toHaveAttribute("data-angle", "192"); expect(book).not.toHaveAttribute("aria-expanded");
    fireEvent.pointerDown(book, { button: 0, pointerId: 2, clientX: 100 });
    fireEvent.pointerMove(book, { pointerId: 2, clientX: 120 }); fireEvent.pointerCancel(book, { pointerId: 2 });
    expect(book).not.toHaveClass("is-dragging");
  });
  it("settles only after the actual front, back and spine illustration have decoded", async () => {
    const ready = vi.fn(); const { container } = render(<MangaBook {...props} onReady={ready} />);
    const front = container.querySelector<HTMLImageElement>('.manga-bb-front img')!;
    let decode!: () => void;
    Object.defineProperty(front, "decode", { value: () => new Promise<void>(resolve => { decode = resolve; }) });
    await act(async () => { container.querySelectorAll('img').forEach(image => fireEvent.load(image)); });
    expect(ready).not.toHaveBeenCalled();
    await act(async () => decode()); expect(ready).toHaveBeenCalled();
    expect(container.querySelector('.manga-bb-back img')).toHaveAttribute("src", "/cover");
    expect(container.querySelector('.manga-bb-pages')).not.toHaveTextContent(/./);
  });
  it("prints title, number and author only on the big book and cuts its own cover at the stored focus", () => {
    const { container, rerender } = render(<MangaBook {...props} />);
    const spine = container.querySelector('.manga-jspine')!;
    expect([...spine.children].map(node => node.textContent)).toEqual(["위치 WATCH", "2", "", "작가 이름", ""]);
    const image = spine.querySelector<HTMLImageElement>('img')!;
    expect(image.style.objectPosition).toBe("50% 30%");
    rerender(<MangaBook {...props} focus={.25} />);
    expect(spine.querySelector('img')).toBe(image);
    expect(image.style.objectPosition).toBe(`${stripPosition(.25, 560 * .71, 34)}% 30%`);
    const manga: MangaWorkData = { volumes: [{ id: "v2", volumeNumber: 2, editionIndex: 0, displayLabel: "2", coverArtworkId: "cover", localReleaseDate: null, isbn13: null, releaseStatus: null }], activeVolumeId: "v2", editionIndex: 0, focuses: [], ownedNumbers: null, scope: "", revision: "", ownership: null, management: null };
    render(<MangaBookcase manga={manga} privacy={false} onPick={vi.fn()} />);
    const shelf = screen.getByRole("group", { name: "권별 책장" });
    expect(shelf.querySelector('.manga-jspine')).toBeNull();
    expect(shelf).not.toHaveTextContent("위치 WATCH"); expect(shelf).not.toHaveTextContent("작가 이름");
  });
  it("masks all printed art in privacy mode", () => {
    const ready = vi.fn(); const { container } = render(<MangaBook {...props} privacy onReady={ready} />);
    expect(container.querySelector('img')).toBeNull(); expect(container.querySelector('.manga-jspine')).toBeNull();
    expect(ready).toHaveBeenCalled();
  });
  it("centres the focus using the illustration's actual cropped height", () => {
    vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockImplementation(function (this: HTMLElement) { return this.classList.contains("manga-jspine-illustration") ? 34 : 0; });
    vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockImplementation(function (this: HTMLElement) { return this.classList.contains("manga-jspine-illustration") ? 200 : 0; });
    const { container } = render(<MangaBook {...props} focus={.25} />);
    expect(container.querySelector<HTMLImageElement>('.manga-jspine-illustration img')!.style.objectPosition).toBe(`${stripPosition(.25, 200 * .71, 34)}% 30%`);
  });
  it("ignores an old decode after changing away from and back to the same cover", async () => {
    const ready = vi.fn(); const view = render(<MangaBook {...props} onReady={ready} />);
    const front = view.container.querySelector<HTMLImageElement>('.manga-bb-front img')!;
    const pending: (() => void)[] = [];
    Object.defineProperty(front, "decode", { value: () => new Promise<void>(resolve => pending.push(resolve)) });
    fireEvent.load(front);
    view.rerender(<MangaBook {...props} src="/other" onReady={ready} />);
    view.rerender(<MangaBook {...props} onReady={ready} />);
    await act(async () => view.container.querySelectorAll('img').forEach(image => fireEvent.load(image)));
    await act(async () => pending[0]()); expect(ready).not.toHaveBeenCalled();
    await act(async () => pending[1]()); expect(ready).toHaveBeenCalled();
  });
});
