import { openUrl } from "@tauri-apps/plugin-opener";
import { ArrowTopRightOnSquareIcon } from "@heroicons/react/24/outline";
import { useCallback, useEffect, useRef, useState } from "react";
import { mangaPageUrl } from "../assets/mediaUrl";
import { libraryGateway } from "../library/client";
import { PageViewer } from "./PageViewer";

type MangaViewerProps = {
  seriesId: string;
  title: string;
  pageCount: number;
  galleryId: string | null;
  onClose: () => void;
};

export function MangaViewer({ seriesId, title, pageCount, galleryId, onClose }: MangaViewerProps) {
  const [savedPage, setSavedPage] = useState<{ seriesId: string; page: number } | null>(null);
  const saveTimerRef = useRef<number | null>(null);
  const pendingSaveRef = useRef<{ seriesId: string; page: number; pageCount: number } | null>(null);

  const flushProgress = useCallback(() => {
    if (saveTimerRef.current !== null) window.clearTimeout(saveTimerRef.current);
    saveTimerRef.current = null;
    const pending = pendingSaveRef.current;
    pendingSaveRef.current = null;
    if (pending) void libraryGateway.saveMangaReadingProgress(pending.seriesId, pending.page, pending.pageCount).catch(() => undefined);
  }, []);

  useEffect(() => {
    let active = true;
    void libraryGateway.getMangaReadingProgress(seriesId)
      .then(progress => {
        if (active) {
          const page = progress?.lastPage ?? 1;
          pendingSaveRef.current = { seriesId, page, pageCount };
          setSavedPage({ seriesId, page });
        }
      })
      .catch(() => {
        if (active) {
          setSavedPage({ seriesId, page: 1 });
        }
      });
    return () => { active = false; };
  }, [pageCount, seriesId]);

  useEffect(() => flushProgress, [flushProgress]);

  const recordPage = (page: number) => {
    pendingSaveRef.current = { seriesId, page, pageCount };
    if (saveTimerRef.current !== null) window.clearTimeout(saveTimerRef.current);
    saveTimerRef.current = window.setTimeout(flushProgress, 1_000);
  };
  const close = () => {
    flushProgress();
    onClose();
  };

  if (savedPage?.seriesId !== seriesId) return null;
  const pageUrls = Array.from({ length: pageCount }, (_, index) => mangaPageUrl(seriesId, index + 1));
  return <PageViewer
    title={title}
    pageUrls={pageUrls}
    initialPage={savedPage.page}
    sourceLabel="로컬"
    onPageChange={recordPage}
    onClose={close}
    actions={galleryId ? <button
      type="button"
      className="ui-button ui-button--ghost"
      aria-label="kHentai에서 열기"
      onClick={() => void openUrl(`https://k-hentai.org/r/${galleryId}`)}
    ><ArrowTopRightOnSquareIcon aria-hidden="true" />kHentai에서 열기</button> : undefined}
  />;
}
