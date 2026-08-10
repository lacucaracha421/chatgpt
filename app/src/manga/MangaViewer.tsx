import { useState } from "react";
import { ChevronLeftIcon, ChevronRightIcon, XMarkIcon } from "@heroicons/react/24/outline";
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
  const move = (next: number) => setPage(Math.max(1, Math.min(pageCount, next)));

  return <Dialog
    open
    variant="fullscreen"
    title={title}
    onClose={onClose}
    onKeyDown={(event) => {
      if (event.key === "ArrowLeft") { event.preventDefault(); move(page - 1); }
      if (event.key === "ArrowRight") { event.preventDefault(); move(page + 1); }
    }}
  >
    <div className="manga-viewer">
      <div className="manga-viewer__controls">
        <span className="manga-viewer__progress">{page} / {pageCount}</span>
        <Button size="icon" variant="ghost" aria-label="이전 페이지" disabled={page <= 1} onClick={() => move(page - 1)}><ChevronLeftIcon aria-hidden="true" /></Button>
        <Button size="icon" variant="ghost" aria-label="다음 페이지" disabled={page >= pageCount} onClick={() => move(page + 1)}><ChevronRightIcon aria-hidden="true" /></Button>
        <Button size="icon" variant="ghost" aria-label="망가 뷰어 닫기" onClick={onClose}><XMarkIcon aria-hidden="true" /></Button>
      </div>
      <div className="manga-viewer__stage">
        {/* ponytail: no preload; the browser image cache covers rapid page turns, add preload only if flashes appear */}
        <img
          key={page}
          className="manga-viewer__page"
          src={mangaPageUrl(seriesId, page)}
          alt={`${title} ${page}페이지`}
          draggable={false}
        />
      </div>
      <div className="manga-viewer__edges">
        <button type="button" className="manga-viewer__edge" aria-label="이전 페이지" disabled={page <= 1} onClick={() => move(page - 1)} />
        <button type="button" className="manga-viewer__edge" aria-label="다음 페이지" disabled={page >= pageCount} onClick={() => move(page + 1)} />
      </div>
    </div>
  </Dialog>;
}
