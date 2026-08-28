import { useState } from "react";
import { BookOpenIcon, ChevronLeftIcon, ChevronRightIcon, XMarkIcon } from "@heroicons/react/24/outline";
import { usePrivacy } from "../privacy/PrivacyContext";
import { Button } from "../shared/ui/Button";
import { Dialog } from "../shared/ui/Dialog";
import { Skeleton } from "../shared/ui/Skeleton";

type PageViewerProps = {
  title: string;
  pageUrls: string[];
  initialPage: number;
  sourceLabel: string;
  onPageChange: (page: number) => void;
  onClose: () => void;
};

export function PageViewer({ title, pageUrls, initialPage, sourceLabel, onPageChange, onClose }: PageViewerProps) {
  const { privacyMode } = usePrivacy();
  const pageCount = pageUrls.length;
  const [page, setPage] = useState(() => Math.max(1, Math.min(pageCount, initialPage)));
  const [spread, setSpread] = useState(false);
  const [failedPages, setFailedPages] = useState<Set<number>>(() => new Set());
  const spreadIndex = (value: number) => value === 1 ? 1 : Math.floor((value + 2) / 2);
  const spreadStart = (index: number) => index === 1 ? 1 : 2 * index - 2;
  const spreadCount = 1 + Math.ceil((pageCount - 1) / 2);
  const viewPages = (value: number): number[] => !spread || value === 1 ? [value] : value < pageCount ? [value, value + 1] : [value];
  const nextPage = (value: number) => spread ? spreadStart(Math.min(spreadCount, spreadIndex(value) + 1)) : Math.min(pageCount, value + 1);
  const prevPage = (value: number) => spread ? spreadStart(Math.max(1, spreadIndex(value) - 1)) : Math.max(1, value - 1);
  const move = (next: number) => {
    const bounded = Math.max(1, Math.min(pageCount, next));
    setPage(bounded);
    onPageChange(bounded);
  };
  const pages = viewPages(page);
  const preloadPages = [...new Set([
    ...viewPages(prevPage(page)),
    ...Array.from({ length: 5 }, (_, index) => page + index + 1).filter((value) => value <= pageCount),
  ])].filter((value) => !pages.includes(value));
  const progress = pages.length === 2 ? `${pages[0]}-${pages[1]} / ${pageCount}` : `${pages[0]} / ${pageCount}`;

  return <Dialog open variant="fullscreen" title={title} onClose={onClose} onKeyDown={(event) => {
    if (event.key === "ArrowLeft") { event.preventDefault(); move(prevPage(page)); }
    if (event.key === "ArrowRight") { event.preventDefault(); move(nextPage(page)); }
    if (event.key.toLowerCase() === "v") { event.preventDefault(); setSpread((value) => !value); }
  }}>
    <div className="manga-viewer">
      <div className="manga-viewer__controls">
        <span className="manga-viewer__source">{sourceLabel}</span>
        <span className="manga-viewer__progress">{progress}</span>
        <Button size="icon" variant="ghost" aria-label={spread ? "단면 보기" : "양면 보기"} aria-pressed={spread} onClick={() => setSpread((value) => !value)}><BookOpenIcon aria-hidden="true" /></Button>
        <Button size="icon" variant="ghost" aria-label="이전 페이지" disabled={page <= 1} onClick={() => move(prevPage(page))}><ChevronLeftIcon aria-hidden="true" /></Button>
        <Button size="icon" variant="ghost" aria-label="다음 페이지" disabled={page >= pageCount} onClick={() => move(nextPage(page))}><ChevronRightIcon aria-hidden="true" /></Button>
        <Button size="icon" variant="ghost" aria-label="망가 뷰어 닫기" onClick={onClose}><XMarkIcon aria-hidden="true" /></Button>
      </div>
      <div className="manga-viewer__stage">
        <div className={`manga-viewer__spread${spread ? " manga-viewer__spread--double" : ""}`}>
          {pages.map((value) => failedPages.has(value)
            ? <span key={value} className="manga-viewer__page-error">{value}페이지를 불러오지 못했습니다</span>
            : privacyMode
              ? <Skeleton key={value} className="privacy-mask manga-viewer__page" label="비공개 모드" />
              : <img key={value} className="manga-viewer__page" src={pageUrls[value - 1]} alt={`${title} ${value}페이지`} referrerPolicy="no-referrer" draggable={false} onError={() => setFailedPages((current) => new Set(current).add(value))} />)}
        </div>
        {!privacyMode && preloadPages.filter((value) => !failedPages.has(value)).map((value) => <img key={`preload-${value}`} className="manga-viewer__preload" src={pageUrls[value - 1]} alt="" referrerPolicy="no-referrer" aria-hidden="true" />)}
      </div>
      <div className="manga-viewer__edges">
        <button type="button" className="manga-viewer__edge" aria-label="이전 페이지" disabled={page <= 1} onClick={() => move(prevPage(page))} />
        <button type="button" className="manga-viewer__edge" aria-label="다음 페이지" disabled={page >= pageCount} onClick={() => move(nextPage(page))} />
      </div>
    </div>
  </Dialog>;
}
