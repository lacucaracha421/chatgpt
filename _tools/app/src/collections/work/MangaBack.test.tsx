import { displayDate } from "../../shared/displayDate";
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { coverAverageColor, MangaBack, MANGA_BACK_COLOR } from "./MangaBack";

afterEach(() => { cleanup(); vi.restoreAllMocks(); });
const props = { title: "Series", volumeNumber: 12, picture: <img src="/cover" alt="" />, color: MANGA_BACK_COLOR };
describe("generated manga back", () => {
  it("prints volume copy and real ISBN bars, publication and Korean list price", () => {
    const { container } = render(<MangaBack {...props} isbn13="9780306406157" contents="Volume synopsis" localReleaseDate="2026-10-04" publisher="Publisher" price={12000} />);
    expect(container).toHaveTextContent("Series 12");
    expect(container).toHaveTextContent("Volume synopsis");
    expect(container).toHaveTextContent(`Publisher${displayDate("2026-10-04")}`);
    expect(container).toHaveTextContent("ISBN 9780306406157");
    expect(container).toHaveTextContent("값 12,000원");
    expect(container.querySelector("svg")).toHaveAttribute("viewBox", "0 0 113 32");
    expect(container.querySelectorAll("rect").length).toBeGreaterThan(20);
  });
  it("omits missing fields on the tablet and never invents a barcode", () => {
    const { container, rerender } = render(<MangaBack {...props} />);
    expect(container.querySelector(".manga-back-code")).toBeNull();
    expect(container.querySelector(".manga-back-synopsis")).toBeNull();
    rerender(<MangaBack {...props} isbn13="9780306406157" localReleaseDate="2026-10-04" contents="  " price={0} />);
    expect(container.querySelector("svg")).not.toBeNull();
    expect(container).toHaveTextContent(displayDate("2026-10-04"));
    expect(container.querySelector(".manga-back-price")).toBeNull();
    expect(container.querySelector(".manga-back-synopsis")).toBeNull();
    rerender(<MangaBack {...props} isbn13="9780306406158" price={NaN} />);
    expect(container.querySelector("svg")).toBeNull();
    expect(container.querySelector(".manga-back-price")).toBeNull();
  });
});

describe("cover colour", () => {
  function loaded() {
    const image = new Image();
    Object.defineProperties(image, { naturalWidth: { value: 100 }, naturalHeight: { value: 150 } });
    return image;
  }
  it("averages an 8 by 8 downsample of the loaded cover, ignoring transparent pixels", () => {
    const drawImage = vi.fn();
    const getImageData = vi.fn(() => ({ data: new Uint8ClampedArray([100, 20, 40, 255, 200, 40, 80, 255, 0, 0, 0, 0]) }));
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({ drawImage, getImageData } as unknown as CanvasRenderingContext2D);
    const image = loaded();
    expect(coverAverageColor(image)).toBe("#961e3c");
    expect(drawImage).toHaveBeenCalledWith(image, 0, 0, 8, 8);
    expect(getImageData).toHaveBeenCalledWith(0, 0, 8, 8);
  });
  it("uses the fallback for unreadable, empty and failed canvases", () => {
    const context = vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
    expect(coverAverageColor(loaded())).toBe(MANGA_BACK_COLOR);
    context.mockImplementation(() => { throw new DOMException("Tainted", "SecurityError"); });
    expect(coverAverageColor(loaded())).toBe(MANGA_BACK_COLOR);
    expect(coverAverageColor(new Image())).toBe(MANGA_BACK_COLOR);
    context.mockReturnValue({ drawImage() {}, getImageData() { throw new DOMException("Tainted", "SecurityError"); } } as unknown as CanvasRenderingContext2D);
    expect(coverAverageColor(loaded())).toBe(MANGA_BACK_COLOR);
  });
});
