import { act, fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { MangaBookcase, type MangaWorkData } from "./MangaBookcase";
import { sampleMangaSpineColor } from "./mangaSpineColor";

vi.mock("./mangaSpineColor", () => ({ useMangaSpineInk: () => null, mangaSpineColor: () => "#45423e", sampleMangaSpineColor: vi.fn(() => "#123456") }));
const side = "http://lakomics.localhost/manga-spine-scan/9780000000001/side";
const back = "http://lakomics.localhost/manga-spine-scan/9780000000001/back";
const manga: MangaWorkData = {
  volumes: [{ id: "scan-v1", volumeNumber: 1, editionIndex: 0, displayLabel: "1", coverArtworkId: "cover", isbn13: "9780000000001", localReleaseDate: null, releaseStatus: null, spineScan: { side: side.replace("http://lakomics.localhost/", ""), back: back.replace("http://lakomics.localhost/", "") } }],
  activeVolumeId: "scan-v1", editionIndex: 0, focuses: [], ownedNumbers: [], scope: "scans", revision: "", ownership: null, management: null,
};
function scan(container: HTMLElement, src: string) { return container.querySelector<HTMLImageElement>(`img[src="${src}"]`)!; }
async function decode(image: HTMLImageElement) {
  Object.defineProperties(image, { naturalWidth: { value: 72 }, naturalHeight: { value: 1200 } });
  image.decode = vi.fn().mockResolvedValue(undefined);
  await act(async () => { fireEvent.load(image); });
}
describe("bookstore scans", () => {
  it("uses tablet cache URLs on the pulled-out book after a touch tap", async () => {
    const cacheSide = "https://appassets.androidplatform.net/cache/side.jpg";
    const cacheBack = "https://appassets.androidplatform.net/cache/back.jpg";
    const touchManga = {...manga, volumes: [{...manga.volumes[0], spineScan: {side: cacheSide, back: cacheBack}}]};
    const onPick = vi.fn();
    const view = render(<MangaBookcase list manga={touchManga} privacy={false} touchTargets onPick={onPick}/>);
    await decode(scan(view.container, cacheSide));
    const button = screen.getByRole("button", {name: /^1/});
    const track = view.container.querySelector<HTMLElement>(".home-shelf__track")!;
    Object.defineProperty(button, "getBoundingClientRect", {value: () => ({left: 0, width: 30, height: 120, bottom: 140})});
    for (const type of ["pointerdown", "pointerup"]) {
      const event = new Event(type, {bubbles: true});
      Object.assign(event, {pointerId: 1, clientX: 15, clientY: 10, button: 0, isPrimary: true});
      fireEvent(track, event);
    }
    fireEvent.click(button, {detail: 1});
    expect(document.querySelector(".manga-shelf-out .paperback-back img")).toHaveAttribute("src", cacheBack);
    expect(onPick).toHaveBeenCalledOnce();
    expect(sampleMangaSpineColor).toHaveBeenCalledWith(cacheSide, scan(view.container, cacheSide));
  });
  it("loads and samples scans through the Linux media origin", async () => {
    const { mockConvertFileSrc, clearMocks } = await import("@tauri-apps/api/mocks");
    Object.defineProperty(window, "isTauri", { configurable: true, value: true });
    try {
      mockConvertFileSrc("linux");
      const view = render(<MangaBookcase manga={manga} privacy={false} onPick={() => {}} />);
      const image = scan(view.container, side.replace("http://lakomics.localhost", "lakomics://localhost"));
      expect(image).toHaveAttribute("crossorigin", "anonymous");
      await decode(image);
      expect(sampleMangaSpineColor).toHaveBeenCalledWith(manga.volumes[0].spineScan!.side, image);
    } finally {
      clearMocks();
      Reflect.deleteProperty(window, "isTauri");
    }
  });
  it("keeps the printed fallback through decoding, then samples the real unowned spine", async () => {
    const view = render(<MangaBookcase manga={manga} privacy={false} onPick={() => {}} />);
    const image = scan(view.container, side);
    expect(image).toHaveAttribute("crossorigin", "anonymous");
    const strip = image.closest(".manga-spine-strip")!;
    expect(strip).not.toHaveClass("manga-spine-strip--scanned");
    let finish!: () => void;
    Object.defineProperties(image, { naturalWidth: { value: 72 }, naturalHeight: { value: 1200 } });
    image.decode = () => new Promise<void>(resolve => { finish = resolve; });
    fireEvent.load(image);
    expect(strip).not.toHaveClass("manga-spine-strip--scanned");
    await act(async () => finish());
    expect(strip).toHaveClass("manga-spine-strip--scanned");
    expect(image.closest("button")).toHaveClass("manga-spine--missing");
    expect(sampleMangaSpineColor).toHaveBeenCalledWith(manga.volumes[0].spineScan!.side, image);
  });
  it("uses the real back as a face and opens from the held book instead of toggling scans", async () => {
    const onPick = vi.fn(), onEnlarge = vi.fn();
    const view = render(<MangaBookcase list manga={manga} privacy={false} onPick={onPick} onEnlarge={onEnlarge} />);
    fireEvent.click(view.container.querySelector("button[data-volume-id]")!);
    const out = document.querySelector<HTMLElement>(".manga-shelf-out")!;
    expect(scan(out, back)).toBeInTheDocument();
    await decode(scan(out, back));
    fireEvent.click(out.querySelector(".kase")!);
    expect(onEnlarge).toHaveBeenCalledExactlyOnceWith("scan-v1");
    expect(onPick).toHaveBeenCalledOnce();
  });
  it("leaves an unscanned back plain and masks every face in privacy mode", () => {
    const noBack = { ...manga, volumes: [{ ...manga.volumes[0], spineScan: { side, back: null } }] };
    const view = render(<MangaBookcase list manga={noBack} privacy={false} onPick={() => {}} />);
    fireEvent.click(view.container.querySelector("button[data-volume-id]")!);
    expect(document.querySelector(".paperback-back")).toBeEmptyDOMElement();
    view.rerender(<MangaBookcase list manga={manga} privacy onPick={() => {}} />);
    expect(scan(document.body, side)).toBeNull(); expect(scan(document.body, back)).toBeNull();
    expect(document.querySelector(".paperback-front .case-mask")).not.toBeNull();
  });
});
