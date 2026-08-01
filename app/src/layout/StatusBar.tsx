import type { AssetBrowserStatus } from "../assets/AssetBrowser";
import type { DropProgress } from "../ingestion/useFileDrop";

type StatusBarProps = {
  status: AssetBrowserStatus;
  progress: DropProgress | null;
  dropEnabled: boolean;
};

export function StatusBar({ status, progress, dropEnabled }: StatusBarProps) {
  const progressText = progress
    ? `${progress.total}개 중 ${progress.current}번째 파일을 처리하고 있습니다.`
    : dropEnabled
      ? "이미지 파일을 창으로 끌어놓으세요."
      : "파일을 저장할 분류를 먼저 선택하세요.";

  return (
    <footer className="status-bar" aria-label="Library status">
      <span>{status.loading ? "Loading assets" : `${status.loadedCount} assets`}</span>
      {status.selectedAsset && <span>{status.selectedAsset.originalName}</span>}
      <span>{progressText}</span>
    </footer>
  );
}
