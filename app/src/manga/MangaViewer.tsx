import { mangaPageUrl } from "../assets/mediaUrl";
import { PageViewer } from "./PageViewer";

type MangaViewerProps = {
  seriesId: string;
  title: string;
  pageCount: number;
  onClose: () => void;
};

export function MangaViewer({ seriesId, title, pageCount, onClose }: MangaViewerProps) {
  const pageUrls = Array.from({ length: pageCount }, (_, index) => mangaPageUrl(seriesId, index + 1));
  return <PageViewer
    title={title}
    pageUrls={pageUrls}
    initialPage={1}
    sourceLabel="로컬"
    onPageChange={() => undefined}
    onClose={onClose}
  />;
}
