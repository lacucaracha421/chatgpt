import { openUrl } from "@tauri-apps/plugin-opener";
import { ArrowTopRightOnSquareIcon } from "@heroicons/react/24/outline";
import { mangaPageUrl } from "../assets/mediaUrl";
import { Button } from "../shared/ui/Button";
import { PageViewer } from "./PageViewer";

type MangaViewerProps = {
  seriesId: string;
  title: string;
  pageCount: number;
  galleryId: string | null;
  artist?: string | null;
  onClose: () => void;
};

/** Local manga in the shared reader. No resume: a work always opens at page 1. */
export function MangaViewer({ seriesId, title, pageCount, galleryId, artist, onClose }: MangaViewerProps) {
  const pageUrls = Array.from({ length: pageCount }, (_, index) => mangaPageUrl(seriesId, index + 1));
  return <PageViewer
    key={seriesId}
    title={title}
    pageUrls={pageUrls}
    initialPage={1}
    sourceLabel="로컬"
    artist={artist}
    onClose={onClose}
    actions={galleryId ? <Button
      className="asset-viewer__vbtn"
      size="icon"
      variant="ghost"
      aria-label="kHentai에서 열기"
      onClick={() => void openUrl(`https://k-hentai.org/r/${galleryId}`)}
    ><ArrowTopRightOnSquareIcon aria-hidden="true" /></Button> : undefined}
  />;
}
