import { useState } from "react";
import { BookOpenIcon, ChevronLeftIcon, ChevronRightIcon, XMarkIcon } from "@heroicons/react/24/outline";
import { mangaPageUrl } from "../assets/mediaUrl";
import { Button } from "../shared/ui/Button";
import { Dialog } from "../shared/ui/Dialog";

type MangaViewerProps = {
  seriesId: string;
  title: string;
  pageCount: number;
  onClose: () => void;
};

export function MangaViewer({ seriesId, title, pageCount, onClose }: MangaViewerProps) {
  const [page, setPage] = useState(1);
  const [spread, setSpread] = useState(false);

  const spreadIndex = (p: number) => (p === 1 ? 1 : Math.floor((p + 2) / 2));
  const spreadStart = (k: number) => (k === 1 ? 1 : 2 * k - 2);
  const spreadCount = 1 + Math.ceil((pageCount - 1) / 2);

  const viewPages = (p: number): number[] => {
    if (!spread || p === 1) return [p];
    return p < pageCount ? [p, p + 1] : [p];
  };
  const nextPage = (p: number) => (spread ? spreadStart(Math.min(spreadCount, spreadIndex(p) + 1)) : Math.min(pageCount, p + 1));
  const prevPage = (p: number) => (spread ? spreadStart(Math.max(1, spreadIndex(p) - 1)) : Math.max(1, p - 1));
  const move = (next: number) => setPage(Math.max(1, Math.min(pageCount, next)));

  const pages = viewPages(page);
  const preloadPages = [...new Set([...viewPages(nextPage(page)), ...viewPages(prevPage(page))])].filter((p) => !pages.includes(p));
  const progress = pages.length === 2 ? `${pages[0]}-${pages[1]} / ${pageCount}` : `${pages[0]} / ${pageCount}`;

  return <Dialog
    open
    variant="fullscreen"
    title={title}
    onClose={onClose}
    onKeyDown={(event) => {
      if (event.key === "ArrowLeft") { event.preventDefault(); move(prevPage(page)); }
      if (event.key === "ArrowRight") { event.preventDefault(); move(nextPage(page)); }
      if (event.key.toLowerCase() === "v") { event.preventDefault(); setSpread((value) => !value); }
    }}
  >
    <div className="manga-viewer">
      <div className="manga-viewer__controls">
        <span className="manga-viewer__progress">{progress}</span>
        <Button size="icon" variant="ghost" aria-label={spread ? "단면 보기" : "양면 보기"} aria-pressed={spread} onClick={() => setSpread((value) => !value)}><BookOpenIcon aria-hidden="true" /></Button>
        <Button size="icon" variant="ghost" aria-label="이전 페이지" disabled={page <= 1} onClick={() => move(prevPage(page))}><ChevronLeftIcon aria-hidden="true" /></Button>
        <Button size="icon" variant="ghost" aria-label="다음 페이지" disabled={page >= pageCount} onClick={() => move(nextPage(page))}><ChevronRightIcon aria-hidden="true" /></Button>
        <Button size="icon" variant="ghost" aria-label="망가 뷰어 닫기" onClick={onClose}><XMarkIcon aria-hidden="true" /></Button>
      </div>
      <div className="manga-viewer__stage">
        <div className={`manga-viewer__spread${spread ? " manga-viewer__spread--double" : ""}`}>
          {pages.map((p) => (
            <img key={p} className="manga-viewer__page" src={mangaPageUrl(seriesId, p)} alt={`${title} ${p}페이지`} draggable={false} />
          ))}
        </div>
        {preloadPages.map((p) => (
          <img key={`preload-${p}`} className="manga-viewer__preload" src={mangaPageUrl(seriesId, p)} alt="" aria-hidden="true" />
        ))}
      </div>
      <div className="manga-viewer__edges">
        <button type="button" className="manga-viewer__edge" aria-label="이전 페이지" disabled={page <= 1} onClick={() => move(prevPage(page))} />
        <button type="button" className="manga-viewer__edge" aria-label="다음 페이지" disabled={page >= pageCount} onClick={() => move(nextPage(page))} />
      </div>
    </div>
  </Dialog>;
}
