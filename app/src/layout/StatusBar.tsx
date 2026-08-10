import type { AssetBrowserStatus } from "../assets/AssetBrowser";
import type { DropProgress } from "../ingestion/useFileDrop";
import type { SimilarityIndexState } from "../similarity/useSimilarityIndex";

type StatusBarProps = {
  status: AssetBrowserStatus;
  progress: DropProgress | null;
  dropEnabled: boolean;
  similarityIndex?: SimilarityIndexState;
};

export function StatusBar({ status, progress, dropEnabled, similarityIndex }: StatusBarProps) {
  const progressText = progress
    ? `${progress.total}개 중 ${progress.current}번째 파일을 처리하고 있습니다.`
    : dropEnabled
      ? "이미지와 영상 파일을 창으로 끌어놓으세요."
      : "현재 화면에서는 파일을 가져올 수 없습니다.";

  return <footer className="status-bar" aria-label="라이브러리 상태">
    <span>{status.loading ? "자산을 불러오는 중입니다." : `${status.loadedCount}개 자산`}</span>
    {status.selectedAsset && <span>{status.selectedAsset.originalName}</span>}
    {similarityIndex?.running && <span>유사 이미지 준비 중 · {similarityIndex.remaining}개 남음</span>}
    {!!similarityIndex?.failed && <span>해시 생성 실패 {similarityIndex.failed}개</span>}
    {similarityIndex?.message && <span>{similarityIndex.message}</span>}
    <span>{progressText}</span>
  </footer>;
}
