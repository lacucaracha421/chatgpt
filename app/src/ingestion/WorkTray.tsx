import { Button } from "../shared/ui/Button";
import type { IngestionWork } from "./useFileDrop";

type WorkTrayProps = {
  works: IngestionWork[];
  retryFailed(workId: string): void;
  dismissWork(workId: string): void;
  openReview(): void;
  openExisting(assetId: string): void;
};

export function WorkTray({ works, retryFailed, dismissWork, openReview, openExisting }: WorkTrayProps) {
  const visible = works.filter((work) => work.kind === "ingestion" || work.status !== "completed");
  if (visible.length === 0) return null;
  return <aside className="work-tray" aria-label="가져오기 작업">
    {visible.map((work) => <div className="work-tray__row" key={work.id}>
      {work.status === "running" ? (
        <span aria-live="polite">
          {work.kind === "drag_out" ? "탐색기로 복사하는 중" : "가져오는 중"} {work.completed} / {work.total}
        </span>
      ) : (
        <div className="work-tray__result">
          <div className="work-tray__result-head">
            <strong>가져오기 결과</strong>
            <Button variant="ghost" size="sm" onClick={() => dismissWork(work.id)}>닫기</Button>
          </div>
          <p>추가 {work.added} · 중복 {work.exactDuplicates.length} · 검토 대기 {work.reviewPending.length} · 실패 {work.failures.length}</p>
          {work.exactDuplicates.map((item) => (
            <Button key={`${item.fileName}-${item.existingAssetId}`} variant="ghost" size="sm" onClick={() => openExisting(item.existingAssetId)}>
              {item.fileName} 기존 이미지 열기
            </Button>
          ))}
          {work.reviewPending.length > 0 && <Button variant="ghost" size="sm" onClick={openReview}>
            검토 대기 {work.reviewPending.length}개 열기
          </Button>}
          {work.reviewPending.map((item) => <span key={item.reviewId}>{item.fileName}</span>)}
          {work.failures.length > 0 && <div className="work-tray__failures">
            <ul>{work.failures.map((failure) => <li key={failure.fileName}><strong>{failure.fileName}</strong><span>{failure.message}</span></li>)}</ul>
            <Button size="sm" onClick={() => retryFailed(work.id)}>실패 파일 다시 시도</Button>
          </div>}
        </div>
      )}
    </div>)}
  </aside>;
}
