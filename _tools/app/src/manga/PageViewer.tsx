import { BusyLabel } from "../shared/ui/BusyLabel";
import { useCallback, useEffect, useRef, useState, type CSSProperties, type ReactNode, type WheelEvent } from "react";
import { ArrowLeftIcon, BookOpenIcon, ChevronLeftIcon, ChevronRightIcon, Cog6ToothIcon, Squares2X2Icon, XMarkIcon } from "@heroicons/react/24/outline";
import { VIEWER_CHROME_IDLE_MS } from "../assets/AssetViewer";
import { useCatalogMasked } from "../privacy/catalogMask";
import { loadUiPreferences, saveUiPreferences } from "../preferences/uiPreferences";
import type { MangaViewerGap, MangaViewerMargin } from "../preferences/uiPreferences";
import { Button } from "../shared/ui/Button";
import { BookmarkToggle } from "../shared/ui/BookmarkToggle";
import { Dialog } from "../shared/ui/Dialog";
import { Menu } from "../shared/ui/Menu";
import { Skeleton } from "../shared/ui/Skeleton";
import { DEFAULT_PAGE_RATIO, ReaderPage, ReaderPageBox } from "./ReaderPage";
import { ReaderControlBar } from "./ReaderControlBar";
import { ReaderSpread } from "./ReaderSpread";
import { arrowAdvance, displayOrder, edgeAdvance, nextSpreadStart, prevSpreadStart, spreadForPage } from "./readerSpreadModel";
import "./reader.css";

type ReaderBookmark = {
  bookmarked: boolean;
  disabled?: boolean;
  onToggle: () => void;
};

type PageViewerProps = {
  title: string;
  pageUrls: string[];
  initialPage: number;
  /** 로컬, or the online catalog's name. */
  sourceLabel: string;
  artist?: string | null;
  /** Online works only: the bookmark toggle in the top bar. */
  bookmark?: ReaderBookmark;
  onPageChange?: (page: number) => void;
  onClose: () => void;
  /** Extra top-bar buttons (use the `asset-viewer__vbtn` look). */
  actions?: ReactNode;
  onRetryPage?: () => Promise<void>;
};

const WHEEL_PAGE_THRESHOLD_PX = 48;
const WHEEL_GESTURE_PAUSE_MS = 200;
const WHEEL_LINE_PX = 16;

const VIEWER_MARGIN_PX: Record<MangaViewerMargin, number> = { compact: 0, normal: 16, wide: 48 };
const VIEWER_GAP_PX: Record<MangaViewerGap, number> = { none: 0, narrow: 8, wide: 24 };

const MARGIN_LABEL: Record<MangaViewerMargin, string> = { compact: "좁게", normal: "보통", wide: "넓게" };
const GAP_LABEL: Record<MangaViewerGap, string> = { none: "없음", narrow: "좁게", wide: "넓게" };

/** The one immersive manga reader for local and online works. */
export function PageViewer(props: PageViewerProps) {
  const privacyMode = useCatalogMasked();
  useEffect(() => { if (privacyMode) props.onClose(); }, [privacyMode, props.onClose]);
  return privacyMode ? <Skeleton className="privacy-mask manga-reader__mask" label="비공개 모드" /> : <PageViewerContent {...props}/>;
}

function PageViewerContent({ title, pageUrls, initialPage, sourceLabel, artist, bookmark, onPageChange, onClose, actions, onRetryPage }: PageViewerProps) {
  const privacyMode = useCatalogMasked();
  const pageCount = pageUrls.length;
  const [page, setPage] = useState(() => Math.max(1, Math.min(pageCount, initialPage)));
  const [retryingPages, setRetryingPages] = useState<Set<number>>(() => new Set());
  async function retryPage(value: number) {
    if (retryingPages.has(value)) return;
    setRetryingPages(current => new Set(current).add(value));
    try {
      await onRetryPage?.();
      setFailedPages(current => { const next = new Set(current); next.delete(value); return next; });
    } catch { /* Keep the failed page and its retry action visible. */ }
    finally { setRetryingPages(current => { const next = new Set(current); next.delete(value); return next; }); }
  }
  const [failedPages, setFailedPages] = useState<Set<number>>(() => new Set());
  const markFailed = (value: number) => setFailedPages((current) => current.has(value) ? current : new Set(current).add(value));
  const [ratios, setRatios] = useState<Record<number, number>>({});
  const recordRatio = useCallback((value: number, ratio: number) => {
    setRatios((current) => Math.abs((current[value] ?? 0) - ratio) < 0.001 ? current : { ...current, [value]: ratio });
  }, []);
  // Pages of one work usually share a shape: guess from the first page seen until a page has its own.
  const typicalRatio = Object.values(ratios)[0] ?? DEFAULT_PAGE_RATIO;
  const ratioFor = (value: number) => ratios[value] ?? typicalRatio;
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
  const chrome = useIdleChrome();
  const lastPointer = useRef<{ x: number; y: number } | null>(null);
  const wheelGesture = useRef({ delta: 0, axis: "y", turned: false, timer: null as number | null });
  useEffect(() => () => {
    if (wheelGesture.current.timer !== null) window.clearTimeout(wheelGesture.current.timer);
  }, []);

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
    onPageChange?.(bounded);
  };
  const goNext = () => move(spread ? nextSpreadStart(page, pageCount, coverSingle) : Math.min(pageCount, page + 1));
  const goPrev = () => move(spread ? prevSpreadStart(page, pageCount, coverSingle) : Math.max(1, page - 1));
  const turnWithWheel = (event: WheelEvent<HTMLDivElement>) => {
    // The enclosing Dialog uses horizontal wheels for Back; the reader owns these gestures.
    // No preventDefault: the page stage cannot scroll, and the slider keeps its native behavior.
    event.stopPropagation();
    const gesture = wheelGesture.current;
    if (gesture.timer !== null) window.clearTimeout(gesture.timer);
    gesture.timer = window.setTimeout(() => {
      gesture.delta = 0;
      gesture.turned = false;
      gesture.timer = null;
    }, WHEEL_GESTURE_PAUSE_MS);
    const ownDialog = event.currentTarget.closest('[role="dialog"]');
    const blocked = overviewOpen || chrome.scrubbing.current || event.ctrlKey || event.metaKey
      || (event.target instanceof Element && !!event.target.closest('input[type="range"]'))
      || !!document.querySelector('[role="menu"]')
      || Array.from(document.querySelectorAll('[role="dialog"], [role="alertdialog"]'))
        .some(dialog => dialog !== ownDialog && dialog.getAttribute("data-state") !== "closed");
    if (blocked) {
      gesture.delta = 0;
      // Do not let the remainder of this gesture turn a page after the overlay closes.
      gesture.turned = true;
      return;
    }
    if (gesture.turned) return;
    const horizontal = Math.abs(event.deltaX) > Math.abs(event.deltaY);
    const axis = horizontal ? "x" : "y";
    const rawDelta = horizontal ? event.deltaX : event.deltaY;
    const factor = event.deltaMode === 1 ? WHEEL_LINE_PX
      : event.deltaMode === 2 ? (event.currentTarget.clientHeight || window.innerHeight) : 1;
    const delta = rawDelta * factor;
    if (!Number.isFinite(delta) || delta === 0) return;
    if (axis !== gesture.axis || Math.sign(delta) !== Math.sign(gesture.delta)) gesture.delta = 0;
    gesture.axis = axis;
    gesture.delta += delta;
    if (Math.abs(gesture.delta) < WHEEL_PAGE_THRESHOLD_PX) return;
    gesture.turned = true;
    // Turning pages leaves the bars as they are (user 2026-10-06); only pointer movement or other keys bring them back.
    const advance = horizontal ? edgeAdvance(delta < 0 ? "left" : "right", direction)
      : delta > 0 ? "next" : "prev";
    if (advance === "next") goNext();
    else goPrev();
  };
  const goTo = (target: number) => move(spread ? (spreadForPage(target, pageCount, coverSingle)[0] ?? target) : target);
  const jumpTo = (target: number) => {
    goTo(target);
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
  const position = logicalSpread.length === 2 ? `${logicalSpread[0]}-${logicalSpread[1]}` : `${logicalSpread[0]}`;
  const subtitle = [artist?.trim(), sourceLabel].filter(Boolean).join(" · ");

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

  const renderPage = (value: number) => {
    const ratio = ratioFor(value);
    if (failedPages.has(value)) {
      return <ReaderPageBox key={value} ratio={ratio}>
        <span className="manga-reader__page-error">{value}페이지를 불러오지 못했습니다<Button disabled={retryingPages.has(value)} onClick={() => void retryPage(value)}><BusyLabel busy={!!(retryingPages.has(value))} idle={"다시 시도"}>재시도 중…</BusyLabel></Button></span>
      </ReaderPageBox>;
    }
    if (privacyMode) {
      return <ReaderPageBox key={value} ratio={ratio}><Skeleton className="privacy-mask manga-reader__mask" label="비공개 모드" /></ReaderPageBox>;
    }
    return <ReaderPage key={`${value}:${pageUrls[value - 1]}`} src={pageUrls[value - 1] ?? ""} alt={`${title} ${value}페이지`} ratio={ratio}
      onRatio={(next) => recordRatio(value, next)} onError={() => markFailed(value)} />;
  };

  const edge = (side: "left" | "right") => {
    const advance = edgeAdvance(side, direction);
    const atBoundary = advance === "next" ? page >= pageCount : page <= 1;
    if (atBoundary) return null;
    return <button
      key={side}
      type="button"
      tabIndex={-1}
      className={`asset-viewer__edge asset-viewer__edge--${side} manga-reader__edge`}
      aria-label={advance === "next" ? "다음 페이지" : "이전 페이지"}
      // Pointer-only: keyboard readers use the arrow keys, so a click never parks focus here.
      onMouseDown={(event) => event.preventDefault()}
      onClick={advance === "next" ? goNext : goPrev}
    >{side === "left" ? <ChevronLeftIcon aria-hidden="true" /> : <ChevronRightIcon aria-hidden="true" />}</button>;
  };

  return <Dialog open variant="fullscreen" title={title} onClose={overviewOpen ? closeOverview : onClose} onKeyDown={(event) => {
    if (event.key === "Tab") chrome.keyboardFocus.current = true;
    // The page scrubber moves with its own arrow keys.
    if (event.target instanceof HTMLInputElement) { chrome.reveal(); return; }
    const advance = arrowAdvance(event.key, direction);
    if (!advance) chrome.reveal();
    if (advance) {
      event.preventDefault();
      if (advance === "next") goNext();
      else goPrev();
      return;
    }
    if (event.key.toLowerCase() === "v") { event.preventDefault(); updatePrefs({ mode: spread ? "single" : "double" }); return; }
    if (event.key.toLowerCase() === "t") { event.preventDefault(); setOverviewOpen((value) => !value); }
  }}>
    <div
      className={`asset-viewer manga-reader${chrome.visible ? "" : " asset-viewer--chrome-hidden"}`}
      data-chrome-visible={chrome.visible}
      onWheel={turnWithWheel}
      onPointerMove={(event) => {
        // Chromium sends a still pointer a move event when the page under it changes; only real movement reveals.
        const last = lastPointer.current;
        lastPointer.current = { x: event.clientX, y: event.clientY };
        if (last && Math.abs(last.x - event.clientX) < 2 && Math.abs(last.y - event.clientY) < 2) return;
        chrome.keyboardFocus.current = false; chrome.reveal();
      }}
      onPointerDown={() => { chrome.keyboardFocus.current = false; }}
    >
      <div className="asset-viewer__stage manga-reader__stage">
        <div className="manga-reader__canvas">
          <ReaderSpread key={privacyMode ? "private" : "visible"} identity={JSON.stringify([pages, pages.map(value => pageUrls[value - 1]), mode, direction, margin, gap])}>
            <div
              className={`manga-reader__spread${spread ? " manga-reader__spread--double" : ""}`}
              style={{ padding: VIEWER_MARGIN_PX[margin], columnGap: VIEWER_GAP_PX[gap], "--reader-gap": `${VIEWER_GAP_PX[gap]}px` } as CSSProperties}
            >
              {pages.map(renderPage)}
            </div>
          </ReaderSpread>
          {!privacyMode && preloadPages.filter((value) => !failedPages.has(value)).map((value) => <img key={`preload-${value}`} className="manga-viewer__preload" src={pageUrls[value - 1]} alt="" referrerPolicy="no-referrer" aria-hidden="true"
            onLoad={(event) => { const image = event.currentTarget; if (image.naturalWidth > 0 && image.naturalHeight > 0) recordRatio(value, image.naturalWidth / image.naturalHeight); }} />)}
        </div>
        <div ref={chrome.ref} className="asset-viewer__chrome" onFocusCapture={chrome.reveal} onBlurCapture={chrome.reveal}>
          <div className="asset-viewer__topbar" {...chrome.hover}>
            <Button className="asset-viewer__vbtn" size="icon" variant="ghost" aria-label="뒤로" onClick={onClose}><ArrowLeftIcon aria-hidden="true" /></Button>
            <span className="asset-viewer__position"><b>{position}</b> / {pageCount}</span>
            <span className="asset-viewer__title">
              <strong>{title}</strong>
              {subtitle && <small>{subtitle}</small>}
            </span>
            <span className="asset-viewer__spacer" />
            {actions}
            <Button className={`asset-viewer__vbtn asset-viewer__vbtn--text${spread ? " asset-viewer__vbtn--on" : ""}`} variant="ghost" aria-label="두 쪽 보기" aria-description="두 쪽 보기 (V)" aria-pressed={spread} onClick={() => updatePrefs({ mode: spread ? "single" : "double" })}><BookOpenIcon aria-hidden="true" /><span>두 쪽</span></Button>
            <Button className="asset-viewer__vbtn" size="icon" variant="ghost" aria-label="페이지 목록" aria-description="페이지 목록 (T)" aria-pressed={overviewOpen} onClick={() => setOverviewOpen((value) => !value)} ref={overviewToggleRef}><Squares2X2Icon aria-hidden="true" /></Button>
            {bookmark && <BookmarkToggle className="asset-viewer__vbtn" label="북마크" bookmarked={bookmark.bookmarked} disabled={bookmark.disabled} onClick={bookmark.onToggle} />}
            <Menu label="읽기 설정" align="end" trigger={<Cog6ToothIcon aria-hidden="true" />} items={settingsItems} />
            <Button className="asset-viewer__vbtn" size="icon" variant="ghost" aria-label="망가 뷰어 닫기" aria-description="망가 뷰어 닫기" onClick={onClose}><XMarkIcon aria-hidden="true" /></Button>
          </div>
          {edge("left")}
          {edge("right")}
          <div className="asset-viewer__filmstrip manga-reader__bottom" dir="ltr" {...chrome.hover}>
            <ReaderControlBar
              page={logicalSpread[0]} pageLabel={position} total={pageCount} direction={direction}
              sliderLabel="페이지 위치" onPageChange={goTo} onNext={goNext} onPrevious={goPrev}
              nextDisabled={(logicalSpread[logicalSpread.length - 1] ?? page) >= pageCount} previousDisabled={logicalSpread[0] <= 1}
              onScrubbingChange={(active) => { chrome.scrubbing.current = active; chrome.reveal(); }}
            />
          </div>
        </div>
      </div>
      {overviewOpen && <div className="manga-viewer__overview" role="dialog" aria-label="페이지 목록">
        <div className="manga-viewer__overview-header">
          <Button variant="ghost" onClick={closeOverview}><ArrowLeftIcon aria-hidden="true" />뷰어로 돌아가기</Button>
          <span>{position} / {pageCount}</span>
        </div>
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
                : <img className="manga-viewer__overview-thumb" src={pageUrls[value - 1]} alt="" loading="lazy" referrerPolicy="no-referrer" draggable={false} />}
              <span className="manga-viewer__overview-number" aria-hidden="true">{value}</span>
            </button>;
          })}
        </div>
      </div>}
    </div>
  </Dialog>;
}

/**
 * The reader's bars fade after the shared viewer idle time and come back on pointer movement or a key
 * press, like the 에셋 viewer; they stay while the pointer rests on them or a Tab-focused control is inside.
 */
function useIdleChrome() {
  const [visible, setVisible] = useState(true);
  const ref = useRef<HTMLDivElement>(null);
  const timerRef = useRef<number | null>(null);
  const pointerOverRef = useRef(false);
  const keyboardFocus = useRef(false);
  const scrubbing = useRef(false);
  const reveal = useCallback(() => {
    setVisible(true);
    if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    timerRef.current = window.setTimeout(() => {
      timerRef.current = null;
      if (pointerOverRef.current || scrubbing.current) return;
      if (keyboardFocus.current && ref.current?.contains(document.activeElement)) return;
      setVisible(false);
    }, VIEWER_CHROME_IDLE_MS);
  }, []);
  useEffect(() => {
    reveal();
    return () => {
      if (timerRef.current !== null) window.clearTimeout(timerRef.current);
      timerRef.current = null;
    };
  }, [reveal]);
  const hover = {
    onPointerEnter: () => { pointerOverRef.current = true; setVisible(true); },
    onPointerLeave: () => { pointerOverRef.current = false; reveal(); },
  };
  return { visible, reveal, hover, ref, keyboardFocus, scrubbing };
}
