import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MangaBook } from "./MangaBook";
import { MangaStage, MangaBookcase, type MangaWorkData } from "./MangaBookcase";
import { stripPosition } from "./coverStrip";
import { WorkZoomObject, WorkZoomProvider, WorkZoomStage } from "./WorkZoom";
import { WorkBackdrop } from "./WorkBackdrop";

afterEach(() => { cleanup(); vi.restoreAllMocks(); });
const props = { src: "/cover", title: "위치 WATCH", author: "작가 이름", volumeNumber: 2, volumeTitle: "2권", focus: null, privacy: false, frontReset: 0, onReady: vi.fn() };
describe("turnable manga book", () => {
  it("forwards PC volume metadata through the shared stage, with tablet fields optional", () => {
    const volume = { id: "v2", volumeNumber: 2, editionIndex: 0, displayLabel: "2", coverArtworkId: null, localReleaseDate: "2026-10-04", isbn13: "9780306406157", releaseStatus: null, contents: "Volume copy", price: 12000, publisher: "Publisher" };
    const manga: MangaWorkData = { volumes: [volume], activeVolumeId: "v2", editionIndex: 0, focuses: [], ownedNumbers: null, scope: "", revision: "", ownership: null, management: null };
    const view = render(<MangaStage manga={manga} privacy={false} title="Series" author="Shinohara Kenta" frontReset={0} onPick={vi.fn()} onReady={vi.fn()} />);
    const back = () => view.container.querySelector(".manga-bb-back")!;
    expect(back()).toHaveTextContent("Volume copy"); expect(back()).toHaveTextContent("값 12,000원"); expect(back()).toHaveTextContent("Publisher");
    view.rerender(<MangaStage manga={{ ...manga, volumes: [{ ...volume, contents: undefined, price: undefined, publisher: undefined }] }} privacy={false} title="Series" author="Shinohara Kenta" frontReset={0} onPick={vi.fn()} onReady={vi.fn()} />);
    expect(back()).toHaveTextContent("ISBN 9780306406157"); expect(back()).toHaveTextContent("2026-10-04");
    expect(back().querySelector(".manga-back-synopsis")).toBeNull(); expect(back().querySelector(".manga-back-price")).toBeNull();
  });
  it("waits for the generated back picture decode too", async () => {
    const ready = vi.fn(); const { container } = render(<MangaBook {...props} onReady={ready} />);
    const back = container.querySelector<HTMLImageElement>(".manga-back-picture img")!;
    let decode!: () => void;
    Object.defineProperty(back, "decode", { value: () => new Promise<void>(resolve => { decode = resolve; }) });
    await act(async () => container.querySelectorAll("img").forEach(image => fireEvent.load(image)));
    expect(ready).not.toHaveBeenCalled();
    await act(async () => decode()); expect(ready).toHaveBeenCalled();
  });
  it("keeps the loaded backdrop through rapid cover changes and ignores stale decodes, even on returning to a pending cover", async () => {
    const view = render(<WorkBackdrop src="/one"/>);
    const old = view.container.querySelector<HTMLImageElement>('img')!;
    await act(async () => fireEvent.load(old));
    view.rerender(<WorkBackdrop src="/two"/>);
    const cancelled = view.container.querySelector<HTMLImageElement>('img[src="/two"]')!;
    let decoded!: () => void;
    Object.defineProperty(cancelled, 'decode', { value: () => new Promise<void>(resolve => { decoded = resolve; }) });
    fireEvent.load(cancelled);
    view.rerender(<WorkBackdrop src="/three"/>);
    view.rerender(<WorkBackdrop src="/two"/>);
    const next = view.container.querySelector<HTMLImageElement>('img[src="/two"]')!;
    expect(next).not.toBe(cancelled);
    await act(async () => decoded()); expect(old).toHaveClass('is-painted'); expect(next).not.toHaveClass('is-painted');
    await act(async () => fireEvent.load(next)); expect(next).toHaveClass('is-painted'); expect(old).not.toHaveClass('is-painted');
  });
  it("pinches without turning, stays blocked until both fingers lift, then supports a new single-finger drag", () => {
    const { container } = render(<WorkZoomProvider workId="manga" reset={0}><WorkZoomStage><WorkZoomObject><MangaBook {...props}/></WorkZoomObject></WorkZoomStage></WorkZoomProvider>);
    const book = screen.getByRole('group', { name: '책' });
    fireEvent.pointerDown(book, { pointerType: 'touch', button: 0, pointerId: 1, clientX: 100, clientY: 100 });
    fireEvent.pointerDown(book, { pointerType: 'touch', button: 0, pointerId: 2, clientX: 200, clientY: 100 });
    fireEvent.pointerMove(book, { pointerType: 'touch', pointerId: 2, clientX: 300, clientY: 100 });
    expect(container.querySelector('.work-zoom-object')).toHaveAttribute('data-zoom', '2');
    expect(book).toHaveAttribute('data-angle', '0');
    fireEvent.pointerUp(book, { pointerType: 'touch', pointerId: 2 });
    fireEvent.pointerMove(book, { pointerType: 'touch', pointerId: 1, clientX: 160, clientY: 100 });
    expect(book).toHaveAttribute('data-angle', '0');
    fireEvent.pointerUp(book, { pointerType: 'touch', pointerId: 1 });
    fireEvent.pointerDown(book, { pointerType: 'touch', button: 0, pointerId: 3, clientX: 100, clientY: 100 });
    fireEvent.pointerMove(book, { pointerType: 'touch', pointerId: 3, clientX: 150, clientY: 100 });
    expect(book).toHaveAttribute('data-angle', '30');
  });
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
    expect([...spine.children].map(node => node.getAttribute("aria-hidden") === "true" ? null : node.textContent)).toEqual(["위치 WATCH", "2", "", "작가이름", "", null, null]);
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
  it("shrinks a long title, then sets two columns split at the subtitle, measured before paint", () => {
    const long = "드래곤 퀘스트 다이의 대모험 : 용사 아방과 옥염의 마왕";
    // Each character measures one base em (22px); the fixed title band is 213px.
    vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockImplementation(function (this: HTMLElement) { return this.dataset.text ? Array.from(this.dataset.text).length * 22 : 0; });
    vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockImplementation(function (this: HTMLElement) { return this.classList.contains("manga-jspine") ? 34 : 0; });
    vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockImplementation(function (this: HTMLElement) { return this.classList.contains("manga-jspine") ? 560 : 0; });
    const { container, rerender } = render(<MangaBook {...props} title="원피스" />);
    const title = () => container.querySelector<HTMLElement>(".manga-jspine-title")!;
    expect([...title().querySelectorAll(".manga-jspine-column")].map(node => node.textContent)).toEqual(["원피스"]);
    expect(title().style.getPropertyValue("--title-scale")).toBe("0.66");
    rerender(<MangaBook {...props} title={long} />);
    expect(title()).toHaveClass("manga-jspine-title--columns");
    expect([...title().querySelectorAll(".manga-jspine-column")].map(node => node.textContent)).toEqual(["드래곤 퀘스트 다이의 대모험", "용사 아방과 옥염의 마왕"]);
    rerender(<MangaBook {...props} title="죠죠의 기묘한 모험" />);
    expect(title()).not.toHaveClass("manga-jspine-title--columns");
    expect(Number(title().style.getPropertyValue("--title-scale"))).toBeLessThan(.66);
  });
  it("prints punctuation in vertical forms and short numbers upright", () => {
    const { container } = render(<MangaBook {...props} title="그래, '최강' 12권!" />);
    const title = container.querySelector(".manga-jspine-title")!;
    expect(title).toHaveTextContent("그래︐ ﹁최강﹂ 12권︕");
    expect(title.querySelector(".manga-jspine-tcy")).toHaveTextContent("12");
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
