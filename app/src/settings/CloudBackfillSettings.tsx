import { useCallback, useEffect, useState } from "react";
import { CLOUD_PROGRESS_EVENT, notifyCloudBackfillSupervisor } from "../app/useCloudBackfillSupervisor";
import { useLibrary } from "../library/LibraryContext";
import { commandErrorMessage } from "../library/errorMessage";
import type { CloudBackfillPreflightReport, CloudBackfillProgress } from "../library/types";
import { Button } from "../shared/ui/Button";
import { Toast } from "../shared/ui/Toast";


export function CloudBackfillSettings() {
  const { gateway, library } = useLibrary();
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
    let active = true;
    const receive = (event: Event) => {
      const detail = (event as CustomEvent).detail;
      if (detail.gateway === gateway && detail.libraryRoot === library?.root) {
        setProgress(detail.progress);
        setError(null);
      }
    };
    window.addEventListener(CLOUD_PROGRESS_EVENT, receive);
    void gateway.cloudBackfillProgress().then((next) => { if (active) setProgress(next); })
      .catch((loadError) => { if (active) setError(commandErrorMessage(loadError, "동기화 상태를 불러오지 못했습니다.")); });
    return () => { active = false; window.removeEventListener(CLOUD_PROGRESS_EVENT, receive); };
  }, [gateway, library?.root]);

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
      <h3 className="settings-view__group-title" id="cloud-backfill-title">동기화 상태</h3>
      <p className="settings-view__row-note">PC의 자료를 모바일에서도 볼 수 있도록 복사합니다.</p>
      {error && <Toast tone="error" onDismiss={() => setError(null)}>{error}</Toast>}
      {message && <Toast onDismiss={() => setMessage(null)}>{message}</Toast>}

      <div className="cloud-backfill__status">
        <div className="cloud-backfill__headline">
          <strong>{stateLabel(progress, settled)}</strong>
          {progress && <span>{progress.completed.toLocaleString()} / {total.toLocaleString()}개 ({percent}%)</span>}
        </div>
        <progress aria-label="모바일 라이브러리 동기화 진행률" aria-valuenow={percent} max={100} value={percent} />
        {progress && <p>대기 {progress.queued} · 전송 중 {active}</p>}
        {progress && progress.failed > 0 && <p className="cloud-backfill__problem">확인 필요 {progress.failed.toLocaleString()}개</p>}
        {progress?.lastError && <p className="cloud-backfill__error">최근 오류: {progress.lastError}</p>}
      </div>

      {progress?.activity?.map((activity) => <dl className="settings-view__property" key={activity.direction}>
        <dt>{activity.direction === "capture" ? "클라우드 → PC" : "PC → 클라우드"}</dt>
        <dd>
          <div>마지막 성공 {activity.lastSuccessAt ? new Date(activity.lastSuccessAt).toLocaleString("ko-KR") : "아직 기록 없음"}</div>
          {activity.metadataLastError && <p role="alert">{activity.metadataLastError}</p>}
          {activity.metadataLastSuccessAt && <p>모바일 기록 전송 {new Date(activity.metadataLastSuccessAt).toLocaleString("ko-KR")}</p>}
          {activity.lastError && <p role="alert">{activity.lastError}</p>}
          {activity.problems > 0 && <p>확인 필요 {activity.problems}개</p>}
          <details><summary>최근 실행 상세</summary>
            <p>마지막 시도 {activity.lastAttemptAt ? new Date(activity.lastAttemptAt).toLocaleString("ko-KR") : "아직 기록 없음"} · 처리 {activity.processed}개</p>
          </details>
        </dd>
      </dl>)}
      {(progress?.failed ?? 0) > 0 && <Button size="sm" disabled={busy} onClick={() => void retry()}>실패 항목 다시 시도</Button>}
      <details className="settings-view__advanced"><summary>점검·복구</summary>
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
        {!confirmingStart ? <Button size="sm" disabled={busy || progress?.replicationEnabled === false} onClick={() => setConfirmingStart(true)}>전체 라이브러리 업로드 준비</Button> : <>
          <Button size="sm" disabled={busy} onClick={() => setConfirmingStart(false)}>취소</Button>
          <Button size="sm" disabled={busy} onClick={() => void start()}>업로드 시작 확인</Button>
        </>}
        <Button size="sm" disabled={busy} onClick={() => void reconcile()}>중단된 작업 복구</Button>
      </div>
      </details>
    </section>
  );
}

function stateLabel(progress: CloudBackfillProgress | null, settled: boolean): string {
  if (!progress) return "상태 확인 중…";
  if (progress.replicationEnabled === false) return "자동 복제 꺼짐";
  if (progress.queued + progress.preparing + progress.uploading + progress.committing > 0) return "복제 대기·진행 중";
  if (progress.controlState === "running") return "업로드 중";
  if (progress.controlState === "paused") return "자동 복제 꺼짐";
  if (settled && progress.failed > 0) return `복제 완료 — ${progress.completed.toLocaleString()}개 완료, ${progress.failed.toLocaleString()}개 확인 필요`;
  if (settled) return `복제 완료 — ${progress.completed.toLocaleString()}개 완료`;
  return "최신 상태";
}
