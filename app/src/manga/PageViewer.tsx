import { useEffect, useRef, useState, type ReactNode } from "react";
import { BookOpenIcon, ChevronLeftIcon, ChevronRightIcon, Cog6ToothIcon, Squares2X2Icon, XMarkIcon } from "@heroicons/react/24/outline";
import { usePrivacy } from "../privacy/PrivacyContext";
import { loadUiPreferences, saveUiPreferences } from "../preferences/uiPreferences";
import type { MangaViewerGap, MangaViewerMargin } from "../preferences/uiPreferences";
import { Button } from "../shared/ui/Button";
import { Dialog } from "../shared/ui/Dialog";
import { Menu } from "../shared/ui/Menu";
import { Skeleton } from "../shared/ui/Skeleton";
import { StableImage } from "../shared/ui/StableImage";
import { arrowAdvance, displayOrder, edgeAdvance, nextSpreadStart, prevSpreadStart, spreadForPage } from "./readerSpread";

type PageViewerProps = {
  title: string;
  pageUrls: string[];
  initialPage: number;
  sourceLabel: string;
  onPageChange: (page: number) => void;
  onClose: () => void;
  actions?: ReactNode;
};

const VIEWER_MARGIN_PX: Record<MangaViewerMargin, number> = { compact: 0, normal: 16, wide: 48 };
const VIEWER_GAP_PX: Record<MangaViewerGap, number> = { none: 0, narrow: 8, wide: 24 };

const MARGIN_LABEL: Record<MangaViewerMargin, string> = { compact: "좁게", normal: "보통", wide: "넓게" };
const GAP_LABEL: Record<MangaViewerGap, string> = { none: "없음", narrow: "좁게", wide: "넓게" };

export function PageViewer({ title, pageUrls, initialPage, sourceLabel, onPageChange, onClose, actions }: PageViewerProps) {
  const { privacyMode } = usePrivacy();
  const pageCount = pageUrls.length;
  const [page, setPage] = useState(() => Math.max(1, Math.min(pageCount, initialPage)));
  const [failedPages, setFailedPages] = useState<Set<number>>(() => new Set());
  const [readerPrefs, setReaderPrefs] = useState(() => {
    const stored = loadUiPreferences();
    return {
      direction: stored.mangaReadingDirection,
      mode: stored.mangaPageMode,
      coverSingle: stored.mangaCoverSingle,
      margin: stored.mangaViewerMargin,
      gap: stored.mangaViewerGap,
    };
  });
  const [overviewOpen, setOverviewOpen] = useState(false);
  const [overviewFocus, setOverviewFocus] = useState<number | null>(null);
  const overviewToggleRef = useRef<HTMLButtonElement>(null);
  const overviewCurrentRef = useRef<HTMLButtonElement>(null);
  const overviewOpenedOnceRef = useRef(false);
  const overviewGridRef = useRef<HTMLDivElement>(null);

  const { direction, mode, coverSingle, margin, gap } = readerPrefs;
  const spread = mode === "double";

  const updatePrefs = (patch: Partial<typeof readerPrefs>) => {
    setReaderPrefs((current) => {
      const next = { ...current, ...patch };
      saveUiPreferences({
        ...loadUiPreferences(),
        mangaReadingDirection: next.direction,
        mangaPageMode: next.mode,
        mangaCoverSingle: next.coverSingle,
        mangaViewerMargin: next.margin,
        mangaViewerGap: next.gap,
      });
      return next;
    });
  };

  const move = (next: number) => {
    const bounded = Math.max(1, Math.min(pageCount, next));
    setPage(bounded);
    onPageChange(bounded);
  };
  const goNext = () => move(spread ? nextSpreadStart(page, pageCount, coverSingle) : Math.min(pageCount, page + 1));
  const goPrev = () => move(spread ? prevSpreadStart(page, pageCount, coverSingle) : Math.max(1, page - 1));
  const jumpTo = (target: number) => {
    const resolved = spread ? (spreadForPage(target, pageCount, coverSingle)[0] ?? target) : target;
    move(resolved);
    setOverviewOpen(false);
    setOverviewFocus(null);
  };
  const closeOverview = () => {
    setOverviewOpen(false);
    setOverviewFocus(null);
  };
  const moveOverviewFocus = (next: number) => {
    const bounded = Math.max(1, Math.min(pageCount, next));
    setOverviewFocus(bounded);
    overviewGridRef.current?.querySelector<HTMLElement>(`[data-overview-page="${bounded}"]`)?.focus();
  };

  const logicalSpread = spread ? spreadForPage(page, pageCount, coverSingle) : [page];
  const pages = displayOrder(logicalSpread, direction);
  const currentSpread = new Set(logicalSpread);
  const prevViewPages = spread
    ? spreadForPage(prevSpreadStart(page, pageCount, coverSingle), pageCount, coverSingle)
    : page > 1
      ? [page - 1]
      : [];
  const preloadPages = [...new Set([
    ...prevViewPages,
    ...Array.from({ length: 5 }, (_, index) => page + index + 1).filter((value) => value <= pageCount),
  ])].filter((value) => !currentSpread.has(value));
  const progress = logicalSpread.length === 2 ? `${logicalSpread[0]}-${logicalSpread[1]} / ${pageCount}` : `${logicalSpread[0]} / ${pageCount}`;

  useEffect(() => {
    if (!overviewOpen) return;
    // Window capture beats Radix Dialog's own Escape handling, so closing the
    // overview never closes the viewer behind it. But a transient layer above
    // the overview (the reader settings menu) owns Escape first: Radix closes
    // it on its own, so step aside while one is open.
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      if (document.querySelector('[role="menu"]')) return;
      event.preventDefault();
      event.stopPropagation();
      closeOverview();
    };
    window.addEventListener("keydown", closeOnEscape, true);
    return () => window.removeEventListener("keydown", closeOnEscape, true);
  }, [overviewOpen]);

  useEffect(() => {
    // Never steal focus on mount; only move it on open/close transitions.
    if (!overviewOpenedOnceRef.current && !overviewOpen) return;
    overviewOpenedOnceRef.current = true;
    if (!overviewOpen) {
      overviewToggleRef.current?.focus();
      return;
    }
    overviewCurrentRef.current?.focus();
  }, [overviewOpen]);

  const settingsItems = [
    {
      id: "direction",
      label: "오른쪽에서 왼쪽으로 읽기",
      checked: direction === "rtl",
      onSelect: () => updatePrefs({ direction: direction === "rtl" ? "ltr" : "rtl" }),
    },
    {
      id: "cover-single",
      label: "표지 단독 보기",
      checked: coverSingle,
      onSelect: () => updatePrefs({ coverSingle: !coverSingle }),
    },
    ...(["compact", "normal", "wide"] as const).map((value) => ({
      id: `margin-${value}`,
      label: `여백: ${MARGIN_LABEL[value]}`,
      group: "margin",
      selected: margin === value,
      onSelect: () => updatePrefs({ margin: value }),
    })),
    ...(["none", "narrow", "wide"] as const).map((value) => ({
      id: `gap-${value}`,
      label: `페이지 간격: ${GAP_LABEL[value]}`,
      group: "gap",
      selected: gap === value,
      onSelect: () => updatePrefs({ gap: value }),
    })),
  ];

  return <Dialog open variant="fullscreen" title={title} onClose={onClose} onKeyDown={(event) => {
    const advance = arrowAdvance(event.key, direction);
    if (advance) {
      event.preventDefault();
      if (advance === "next") goNext();
      else goPrev();
      return;
    }
    if (event.key.toLowerCase() === "v") { event.preventDefault(); updatePrefs({ mode: spread ? "single" : "double" }); return; }
    if (event.key.toLowerCase() === "t") { event.preventDefault(); setOverviewOpen((value) => !value); }
  }}>
    <div className="manga-viewer">
      <div className="manga-viewer__controls">
        {actions}
        <span className="manga-viewer__source">{sourceLabel}</span>
        <span className="manga-viewer__progress">{progress}</span>
        <Button size="icon" variant="ghost" aria-label="페이지 목록" title="페이지 목록 (T)" aria-pressed={overviewOpen} onClick={() => setOverviewOpen((value) => !value)} ref={overviewToggleRef}><Squares2X2Icon aria-hidden="true" /></Button>
        <Button size="icon" variant="ghost" aria-label={spread ? "단면 보기" : "양면 보기"} title={spread ? "단면 보기 (V)" : "양면 보기 (V)"} aria-pressed={spread} onClick={() => updatePrefs({ mode: spread ? "single" : "double" })}><BookOpenIcon aria-hidden="true" /></Button>
        <Button size="icon" variant="ghost" aria-label="이전 페이지" title="이전 페이지" disabled={page <= 1} onClick={goPrev}><ChevronLeftIcon aria-hidden="true" /></Button>
        <Button size="icon" variant="ghost" aria-label="다음 페이지" title="다음 페이지" disabled={page >= pageCount} onClick={goNext}><ChevronRightIcon aria-hidden="true" /></Button>
        <Menu label="읽기 설정" trigger={<Cog6ToothIcon aria-hidden="true" />} items={settingsItems} />
        <Button size="icon" variant="ghost" aria-label="망가 뷰어 닫기" title="망가 뷰어 닫기" onClick={onClose}><XMarkIcon aria-hidden="true" /></Button>
      </div>
      <div className="manga-viewer__stage">
        <div
          className={`manga-viewer__spread${spread ? " manga-viewer__spread--double" : ""}`}
          style={{ boxSizing: "border-box", padding: VIEWER_MARGIN_PX[margin], columnGap: VIEWER_GAP_PX[gap] }}
        >
          {pages.map((value) => failedPages.has(value)
            ? <span key={value} className="manga-viewer__page-error">{value}페이지를 불러오지 못했습니다</span>
            : privacyMode
              ? <Skeleton key={value} className="privacy-mask manga-viewer__page" label="비공개 모드" />
              : <StableImage key={value} className="manga-viewer__page" src={pageUrls[value - 1]} alt={`${title} ${value}페이지`} referrerPolicy="no-referrer" draggable={false} onError={() => setFailedPages((current) => new Set(current).add(value))} onPreloadError={() => setFailedPages((current) => new Set(current).add(value))} />)}
        </div>
        {!privacyMode && preloadPages.filter((value) => !failedPages.has(value)).map((value) => <img key={`preload-${value}`} className="manga-viewer__preload" src={pageUrls[value - 1]} alt="" referrerPolicy="no-referrer" aria-hidden="true" />)}
      </div>
      <div className="manga-viewer__edges" aria-hidden="true">
        {(["left", "right"] as const).map((side) => {
          const advance = edgeAdvance(side, direction);
          const go = advance === "next" ? goNext : goPrev;
          const atBoundary = advance === "next" ? page >= pageCount : page <= 1;
          return <div
            key={side}
            className="manga-viewer__edge"
            data-disabled={atBoundary ? "true" : undefined}
            onClick={() => { if (!atBoundary) go(); }}
          />;
        })}
      </div>
      {overviewOpen && <div className="manga-viewer__overview" role="dialog" aria-label="페이지 목록">
        <div
          ref={overviewGridRef}
          className="manga-viewer__overview-grid"
          onKeyDown={(event) => {
            const current = overviewFocus ?? logicalSpread[0];
            if (event.key === "ArrowRight" || event.key === "ArrowDown") {
              event.preventDefault();
              moveOverviewFocus(current + 1);
            } else if (event.key === "ArrowLeft" || event.key === "ArrowUp") {
              event.preventDefault();
              moveOverviewFocus(current - 1);
            } else if (event.key === "Home") {
              event.preventDefault();
              moveOverviewFocus(1);
            } else if (event.key === "End") {
              event.preventDefault();
              moveOverviewFocus(pageCount);
            }
          }}
        >
          {Array.from({ length: pageCount }, (_, index) => index + 1).map((value) => {
            const current = currentSpread.has(value);
            return <button
              key={value}
              type="button"
              ref={current && value === logicalSpread[0] ? overviewCurrentRef : undefined}
              data-overview-page={value}
              tabIndex={value === (overviewFocus ?? logicalSpread[0]) ? 0 : -1}
              className={`manga-viewer__overview-item${current ? " manga-viewer__overview-item--current" : ""}`}
              aria-label={`${value}페이지로 이동`}
              aria-current={current ? "true" : undefined}
              onClick={() => jumpTo(value)}
            >
              {privacyMode || failedPages.has(value)
                ? <span className="manga-viewer__overview-placeholder" aria-hidden="true">{value}</span>
                : <img className="manga-viewer__overview-thumb" src={pageUrls[value - 1]} alt="" loading="lazy" draggable={false} />}
              <span className="manga-viewer__overview-number" aria-hidden="true">{value}</span>
            </button>;
          })}
        </div>
      </div>}
    </div>
  </Dialog>;
}
