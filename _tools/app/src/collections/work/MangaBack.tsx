import type { ReactNode } from "react";
import { encodeEan13 } from "./ean13";
import { displayDate } from "../../shared/displayDate";

export type MangaBackData = { isbn13?: string | null; localReleaseDate?: string | null; contents?: string | null; price?: number | null; publisher?: string | null };
export const MANGA_BACK_COLOR = "#5a3f3d";

/** Reuse the decoded cover; asset protocols may forbid reading the canvas. */
export function coverAverageColor(image: HTMLImageElement): string {
  if (!image.naturalWidth || !image.naturalHeight) return MANGA_BACK_COLOR;
  try {
    const canvas = document.createElement("canvas"); canvas.width = 8; canvas.height = 8;
    const context = canvas.getContext("2d"); if (!context) return MANGA_BACK_COLOR;
    context.drawImage(image, 0, 0, 8, 8);
    const { data } = context.getImageData(0, 0, 8, 8);
    let red = 0, green = 0, blue = 0, weight = 0;
    for (let index = 0; index < data.length; index += 4) {
      const alpha = data[index + 3] / 255;
      red += data[index] * alpha; green += data[index + 1] * alpha; blue += data[index + 2] * alpha; weight += alpha;
    }
    return weight ? `#${[red, green, blue].map(channel => Math.round(channel / weight).toString(16).padStart(2, "0")).join("")}` : MANGA_BACK_COLOR;
  } catch { return MANGA_BACK_COLOR; }
}

export function MangaBack({ title, volumeNumber, color, picture, isbn13, localReleaseDate, contents, price, publisher }: MangaBackData & { title: string; volumeNumber: number | null; color: string; picture: ReactNode }) {
  const isbn = isbn13?.trim() ?? "";
  const bits = encodeEan13(isbn);
  return <span className="manga-back-print" style={{ backgroundColor: color }}>
    {picture && <span className="manga-back-picture">{picture}</span>}
    <span className="manga-back-volume">{title}{volumeNumber != null ? ` ${volumeNumber}` : ""}</span>
    {contents?.trim() && <span className="manga-back-synopsis">{contents.trim()}</span>}
    <span className="manga-back-bottom">
      <span className="manga-back-publisher">{publisher?.trim()}<small>{displayDate(localReleaseDate)}</small></span>
      {/^\d{13}$/.test(isbn) && <span className="manga-back-code">
        {bits && <svg viewBox="0 0 113 32" role="img" aria-label={`EAN-13 ${isbn}`} preserveAspectRatio="none" shapeRendering="crispEdges">
          {Array.from(bits, (bit, index) => bit === "1" ? <rect key={index} x={index + 11} y={0} width={1} height={index < 3 || index >= 45 && index < 50 || index >= 92 ? 32 : 28} fill="#111" /> : null)}
        </svg>}
        <span>ISBN {isbn}</span>
        {price != null && Number.isFinite(price) && price > 0 && <span className="manga-back-price">값 {price.toLocaleString("ko-KR")}원</span>}
      </span>}
    </span>
  </span>;
}
