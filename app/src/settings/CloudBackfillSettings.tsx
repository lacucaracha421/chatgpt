import { useCallback, useEffect, useState } from "react";
import { notifyCloudBackfillSupervisor } from "../app/useCloudBackfillSupervisor";
import { useLibrary } from "../library/LibraryContext";
import { commandErrorMessage } from "../library/errorMessage";
import type { CloudBackfillPreflightReport, CloudBackfillProgress } from "../library/types";
import { Button } from "../shared/ui/Button";
import { Toast } from "../shared/ui/Toast";

const ACTIVE_POLL_MS = 1_500;
const INACTIVE_POLL_MS = 10_000;

export function CloudBackfillSettings() {
  const { gateway } = useLibrary();
  const [progress, setProgress] = useState<CloudBackfillProgress | null>(null);
  const [preflight, setPreflight] = useState<CloudBackfillPreflightReport | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmingStart, setConfirmingStart] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const next = await gateway.cloudBackfillProgress();
    setProgress(next);
    return next;
  }, [gateway]);

  useEffect(() => {
    let disposed = false;
    let timer: number | null = null;
    const poll = async () => {
      try {
        const next = await gateway.cloudBackfillProgress();
        if (disposed) return;
        if (!next) {
          timer = window.setTimeout(poll, INACTIVE_POLL_MS);
          return;
        }
        setProgress(next);
        timer = window.setTimeout(poll, next.controlState === "running" ? ACTIVE_POLL_MS : INACTIVE_POLL_MS);
      } catch (loadError) {
        if (!disposed) {
          setError(commandErrorMessage(loadError, "모바일 동기화 상태를 불러오지 못했습니다."));
          timer = window.setTimeout(poll, INACTIVE_POLL_MS);
        }
      }
    };
    void poll();
    return () => { disposed = true; if (timer !== null) window.clearTimeout(timer); };
  }, [gateway]);

  const act = async (action: () => Promise<void>, fallback: string) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await action();
      await refresh();
    } catch (actionError) {
      setError(commandErrorMessage(actionError, fallback));
    } finally {
      setBusy(false);
    }
  };

  const runPreflight = () => act(async () => {
    setPreflight(await gateway.cloudBackfillPreflight());
  }, "사전 점검을 완료하지 못했습니다.");

  const start = () => act(async () => {
    const checked = await gateway.cloudBackfillPreflight();
    setPreflight(checked);
    const seeded = await gateway.cloudBackfillSeed();
    await gateway.cloudBackfillSetControlState?.("running");
    setConfirmingStart(false);
    setMessage(`새로 대기열에 추가 ${seeded.seeded.toLocaleString()}개 · 이미 복제됨 ${seeded.skippedReplicated.toLocaleString()}개`);
    notifyCloudBackfillSupervisor();
  }, "전체 라이브러리 업로드를 시작하지 못했습니다.");

  const pause = () => act(async () => {
    await gateway.cloudBackfillSetControlState?.("paused");
    setMessage("진행 중인 전송을 마친 뒤 새 작업을 시작하지 않습니다.");
    notifyCloudBackfillSupervisor();
  }, "모바일 동기화를 일시정지하지 못했습니다.");

  const resume = () => act(async () => {
    await gateway.cloudBackfillReconcile?.();
    await gateway.cloudBackfillSetControlState?.("running");
    setMessage("남은 작업을 계속합니다.");
    notifyCloudBackfillSupervisor();
  }, "모바일 동기화를 계속하지 못했습니다.");

  const retry = () => act(async () => {
    const report = await gateway.cloudBackfillRetryFailed();
    if (report.retried > 0 && progress?.controlState === "idle") {
      await gateway.cloudBackfillSetControlState?.("running");
    }
    setMessage(`실패 항목 ${report.retried.toLocaleString()}개를 다시 대기열에 넣었습니다.`);
    notifyCloudBackfillSupervisor();
  }, "실패 항목을 다시 시도하지 못했습니다.");

  const reconcile = () => act(async () => {
    const report = await gateway.cloudBackfillReconcile?.();
    setMessage(`중단된 작업 ${report?.requeued ?? 0}개를 대기열로 복구했습니다.`);
    notifyCloudBackfillSupervisor();
  }, "중단된 작업을 복구하지 못했습니다.");

  const active = progress ? progress.preparing + progress.uploading + progress.committing : 0;
  const queueTotal = progress ? progress.queued + active + progress.completed + progress.failed : 0;
  const total = Math.max(progress?.totalAssets ?? 0, queueTotal);
  const percent = total > 0 ? Math.min(100, Math.round(((progress?.completed ?? 0) / total) * 100)) : 0;
  const settled = !!progress && progress.controlState !== "running" && progress.queued + active === 0 && progress.completed + progress.failed > 0;

  return (
    <section className="cloud-backfill" aria-labelledby="cloud-backfill-title">
      <h3 className="settings-view__group-title" id="cloud-backfill-title">모바일 라이브러리 동기화</h3>
      <p className="settings-view__row-note">PC 라이브러리가 원본입니다. PC가 꺼져 있어도 Lakomics Mobile에서 볼 수 있도록 비공개 Cloud에 복사하며, Cloud Capture와는 별개입니다.</p>
      {error && <Toast onDismiss={() => setError(null)}>{error}</Toast>}
      {message && <Toast onDismiss={() => setMessage(null)}>{message}</Toast>}

      <div className="cloud-backfill__status">
        <div className="cloud-backfill__headline">
          <strong>{stateLabel(progress, settled)}</strong>
          {progress && <span>{progress.completed.toLocaleString()} / {total.toLocaleString()}개 ({percent}%)</span>}
        </div>
        <progress aria-label="모바일 라이브러리 동기화 진행률" aria-valuenow={percent} max={100} value={percent} />
        {progress && <p>대기 {progress.queued} · 준비 {progress.preparing} · 업로드 {progress.uploading} · 커밋 {progress.committing} · 작업자 {progress.activeWorkers}</p>}
        {progress && progress.failed > 0 && <p className="cloud-backfill__problem">확인 필요 {progress.failed.toLocaleString()}개</p>}
        {progress?.lastError && <p className="cloud-backfill__error">최근 오류: {progress.lastError}</p>}
      </div>

      {preflight && <div className="cloud-backfill__summary" aria-label="모바일 동기화 사전 점검 결과">
        <span>전체 {preflight.totalAssets.toLocaleString()}개</span>
        <span>준비됨 {preflight.readyAssets.toLocaleString()}개</span>
        <span>이미 복제됨 {preflight.alreadyReplicated.toLocaleString()}개</span>
        <span>원본 문제 {preflight.missingOriginals.toLocaleString()}개</span>
        <span>썸네일 작업 {preflight.thumbnailWorkRequired.toLocaleString()}개</span>
        <span>문제 항목 {preflight.problemAssets.toLocaleString()}개</span>
      </div>}

      <div className="settings-view__actions cloud-backfill__actions">
        <Button size="sm" disabled={busy} onClick={() => void runPreflight()}>사전 점검</Button>
        {progress?.controlState === "running" ? (
          <Button size="sm" disabled={busy} onClick={() => void pause()}>일시정지</Button>
        ) : progress?.controlState === "paused" ? (
          <Button size="sm" variant="primary" disabled={busy} onClick={() => void resume()}>계속</Button>
        ) : !confirmingStart ? (
          <Button size="sm" variant="primary" disabled={busy} onClick={() => setConfirmingStart(true)}>전체 라이브러리 업로드 준비</Button>
        ) : (
          <>
            <Button size="sm" disabled={busy} onClick={() => setConfirmingStart(false)}>취소</Button>
            <Button size="sm" variant="primary" disabled={busy} onClick={() => void start()}>업로드 시작 확인</Button>
          </>
        )}
        {(progress?.failed ?? 0) > 0 && <Button size="sm" disabled={busy} onClick={() => void retry()}>실패 항목 다시 시도</Button>}
        <Button size="sm" disabled={busy} onClick={() => void reconcile()}>중단된 작업 복구</Button>
      </div>
    </section>
  );
}

function stateLabel(progress: CloudBackfillProgress | null, settled: boolean): string {
  if (!progress) return "상태 확인 중…";
  if (progress.controlState === "running") return "업로드 중";
  if (progress.controlState === "paused") return "일시정지됨";
  if (settled && progress.failed > 0) return `복제 완료 — ${progress.completed.toLocaleString()}개 완료, ${progress.failed.toLocaleString()}개 확인 필요`;
  if (settled) return `복제 완료 — ${progress.completed.toLocaleString()}개 완료`;
  return "시작 전";
}
