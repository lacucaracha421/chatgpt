import type { AssetBrowserStatus } from "../assets/AssetBrowser";
import type { DropProgress } from "../ingestion/useFileDrop";
import type { SimilarityIndexState } from "../similarity/useSimilarityIndex";

type StatusBarProps = {
  status: AssetBrowserStatus;
  progress: DropProgress | null;
  dropEnabled: boolean;
  similarityIndex?: SimilarityIndexState;
};

export function StatusBar({ progress, similarityIndex }: StatusBarProps) {
  if (!progress && !similarityIndex?.running && !similarityIndex?.failed && !similarityIndex?.message) return null;
  return <footer className="status-bar" aria-label="라이브러리 상태">
    {similarityIndex?.running && <span>유사 이미지 준비 중 · {similarityIndex.remaining}개 남음</span>}
    {!!similarityIndex?.failed && <span>해시 생성 실패 {similarityIndex.failed}개</span>}
    {similarityIndex?.message && <span>{similarityIndex.message}</span>}
    {progress && <span>파일 가져오기 {progress.current} / {progress.total}</span>}
  </footer>;
}
