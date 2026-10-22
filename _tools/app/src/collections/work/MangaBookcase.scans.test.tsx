import { act, fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { MangaBookcase, type MangaWorkData } from "./MangaBookcase";
import { sampleMangaSpineColor } from "./mangaSpineColor";

vi.mock("./mangaSpineColor", () => ({ mangaSpineColor: () => "#45423e", sampleMangaSpineColor: vi.fn(() => "#123456") }));
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
describe("PC bookstore scans", () => {
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
  it("waits for a real back to decode before turning, and toggles back to the front", async () => {
    const onPick = vi.fn(), onEnlarge = vi.fn();
    const view = render(<MangaBookcase manga={manga} privacy={false} onPick={onPick} onEnlarge={onEnlarge} />);
    const button = screen.getByRole("button", { name: "1권 보기" });
    fireEvent.click(button);
    expect(view.container.querySelector(".manga-spine-turn")).not.toHaveClass("is-back");
    await decode(scan(view.container, back));
    expect(view.container.querySelector(".manga-spine-turn")).toHaveClass("is-back");
    fireEvent.click(button);
    expect(view.container.querySelector(".manga-spine-turn")).not.toHaveClass("is-back");
    expect(onPick).not.toHaveBeenCalled();
    fireEvent.doubleClick(button);
    expect(onEnlarge).not.toHaveBeenCalled();
  });
  it("keeps the existing enlarge action without a back and hides scans on tablet or in privacy mode", () => {
    const onEnlarge = vi.fn();
    const noBack = { ...manga, volumes: [{ ...manga.volumes[0], spineScan: { side: side.replace("http://lakomics.localhost/", ""), back: null } }] };
    const view = render(<MangaBookcase manga={noBack} privacy={false} onPick={() => {}} onEnlarge={onEnlarge} />);
    const front = view.container.querySelector(".manga-spine-face img");
    fireEvent.doubleClick(screen.getByRole("button", { name: "1권 보기" }));
    expect(onEnlarge).toHaveBeenCalledOnce();
    view.rerender(<MangaBookcase manga={manga} privacy={false} onPick={() => {}} />);
    expect(view.container.querySelector(".manga-spine-face img")).toBe(front);
    view.rerender(<MangaBookcase manga={manga} privacy onPick={() => {}} />);
    expect(scan(view.container, side)).toBeNull(); expect(scan(view.container, back)).toBeNull();
    view.rerender(<MangaBookcase manga={manga} privacy={false} touchTargets onPick={() => {}} />);
    expect(scan(view.container, side)).toBeNull(); expect(scan(view.container, back)).toBeNull();
  });
});
