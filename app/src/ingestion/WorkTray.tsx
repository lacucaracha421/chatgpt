import { XMarkIcon } from "@heroicons/react/24/outline";
import { useEffect, useRef, useState } from "react";
import { Button } from "../shared/ui/Button";
import type { IngestionWork } from "./useFileDrop";
import type { MetadataImportWork } from "./metadataImport";

type WorkTrayProps = {
  works: Array<IngestionWork | MetadataImportWork>;
  retryFailed(workId: string): void;
  dismissWork(workId: string): void;
  openReview(): void;
  openExisting(assetId: string): void;
};

type WorkTrayWork = IngestionWork | MetadataImportWork;
const AUTO_DISMISS_MS = 8_000;

export function WorkTray({ works, retryFailed, dismissWork, openReview, openExisting }: WorkTrayProps) {
  const visible = works.filter((work) => work.kind !== "drag_out" || work.status !== "completed");
  if (visible.length === 0) return null;
  return <aside className="work-tray" aria-label="가져오기 작업">
    {visible.map((work) => <WorkTrayRow key={work.id} work={work} retryFailed={retryFailed} dismissWork={dismissWork} openReview={openReview} openExisting={openExisting} />)}
  </aside>;
}

function WorkTrayRow({ work, retryFailed, dismissWork, openReview, openExisting }: {
  work: WorkTrayWork;
  retryFailed(workId: string): void;
  dismissWork(workId: string): void;
  openReview(): void;
  openExisting(assetId: string): void;
}) {
  const [pointerInside, setPointerInside] = useState(false);
  const [focusInside, setFocusInside] = useState(false);
  const remainingMs = useRef(AUTO_DISMISS_MS);
  const startedAt = useRef(0);
  const dismissRef = useRef(dismissWork);
  dismissRef.current = dismissWork;
  const paused = pointerInside || focusInside;
  const metadataDetails = work.kind === "metadata_import" ? [...work.skipped, ...work.failures] : [];
  const visibleMetadataDetails = metadataDetails.slice(0, 3);
  const hiddenMetadataDetailCount = metadataDetails.length - visibleMetadataDetails.length;

  useEffect(() => {
    if (work.status === "running") {
      remainingMs.current = AUTO_DISMISS_MS;
      return;
    }
    if (paused) return;
    startedAt.current = Date.now();
    const timer = window.setTimeout(() => dismissRef.current(work.id), remainingMs.current);
    return () => {
      window.clearTimeout(timer);
      remainingMs.current = Math.max(0, remainingMs.current - (Date.now() - startedAt.current));
    };
  }, [paused, work.id, work.status]);

  return <div
    className="work-tray__row"
    onPointerEnter={() => setPointerInside(true)}
    onPointerLeave={() => setPointerInside(false)}
    onFocus={() => setFocusInside(true)}
    onBlur={(event) => {
      if (!event.currentTarget.contains(event.relatedTarget)) setFocusInside(false);
    }}
  >
      {work.status === "running" ? (
        <span aria-live="polite">
          {work.kind === "drag_out" ? "탐색기로 복사하는 중" : work.kind === "preparation" ? "미리보기 준비 중" : work.kind === "metadata_import" ? "메타데이터 폴더 가져오는 중" : "가져오는 중"} {work.completed} / {work.total}
        </span>
      ) : work.kind === "metadata_import" ? (
        <div className="work-tray__result">
          <div className="work-tray__result-head">
            <strong>메타데이터 폴더 가져오기 결과</strong>
            <ResultDismissButton onClick={() => dismissWork(work.id)} />
          </div>
          <p>폴더 생성 {work.foldersCreated} · 경로 재사용 {work.pathsReused} · 추가 {work.added} · 중복 {work.exactDuplicates.length} · 검토 대기 {work.reviewPending.length} · 건너뜀 {work.skipped.length} · 실패 {work.failures.length}</p>
          {visibleMetadataDetails.map((failure) => {
            const detail = `${failure.fileName}: ${failure.message}`;
            return <span className="work-tray__detail" title={detail} key={detail}>{detail}</span>;
          })}
          {hiddenMetadataDetailCount > 0 && <span className="work-tray__overflow">외 {hiddenMetadataDetailCount}건</span>}
          <Button size="sm" onClick={() => retryFailed(work.id)}>폴더 다시 가져오기</Button>
        </div>
      ) : work.kind === "preparation" ? (
        <div className="work-tray__result">
          <div className="work-tray__result-head">
            <strong>{work.status === "completed" ? "미리보기 준비 완료" : "미리보기 준비 실패"}</strong>
            <ResultDismissButton onClick={() => dismissWork(work.id)} />
          </div>
          {work.failures.map((failure) => <span title={failure.message} key={failure.fileName}>{failure.message}</span>)}
          {work.status === "failed" && <Button size="sm" onClick={() => retryFailed(work.id)}>미리보기 다시 시도</Button>}
        </div>
      ) : (
        <div className="work-tray__result">
          <div className="work-tray__result-head">
            <strong>가져오기 결과</strong>
            <ResultDismissButton onClick={() => dismissWork(work.id)} />
          </div>
          <p>추가 {work.added} · 중복 {work.exactDuplicates.length} · 검토 대기 {work.reviewPending.length} · 실패 {work.failures.length}</p>
          {work.exactDuplicates.map((item) => (
            <Button key={`${item.fileName}-${item.existingAssetId}`} variant="ghost" size="sm" title={`${item.fileName} 기존 자산 열기`} onClick={() => openExisting(item.existingAssetId)}>
              {item.fileName} 기존 자산 열기
            </Button>
          ))}
          {work.reviewPending.length > 0 && <Button variant="ghost" size="sm" onClick={openReview}>
            검토 대기 {work.reviewPending.length}개 열기
          </Button>}
          {work.reviewPending.map((item) => <span title={item.fileName} key={item.reviewId}>{item.fileName}</span>)}
          {work.failures.length > 0 && <div className="work-tray__failures">
            <ul>{work.failures.map((failure) => <li key={failure.fileName}><strong title={failure.fileName}>{failure.fileName}</strong><span title={failure.message}>{failure.message}</span></li>)}</ul>
            <Button size="sm" onClick={() => retryFailed(work.id)}>실패 파일 다시 시도</Button>
          </div>}
        </div>
      )}
    </div>;
}

function ResultDismissButton({ onClick }: { onClick(): void }) {
  return <Button size="icon" variant="ghost" aria-label="결과 닫기" onClick={onClick}><XMarkIcon aria-hidden="true" /></Button>;
}
