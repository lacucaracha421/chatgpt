import { openUrl } from "@tauri-apps/plugin-opener";
import { ArrowTopRightOnSquareIcon } from "@heroicons/react/24/outline";
import { mangaPageUrl } from "../assets/mediaUrl";
import { PageViewer } from "./PageViewer";

type MangaViewerProps = {
  seriesId: string;
  title: string;
  pageCount: number;
  galleryId: string | null;
  onClose: () => void;
};

export function MangaViewer({ seriesId, title, pageCount, galleryId, onClose }: MangaViewerProps) {
  const pageUrls = Array.from({ length: pageCount }, (_, index) => mangaPageUrl(seriesId, index + 1));
  return <PageViewer
    title={title}
    pageUrls={pageUrls}
    initialPage={1}
    sourceLabel="로컬"
    onPageChange={() => undefined}
    onClose={onClose}
    actions={galleryId ? <button
      type="button"
      className="ui-button ui-button--ghost"
      aria-label="kHentai에서 열기"
      onClick={() => void openUrl(`https://k-hentai.org/r/${galleryId}`)}
    ><ArrowTopRightOnSquareIcon aria-hidden="true" />kHentai에서 열기</button> : undefined}
  />;
}
