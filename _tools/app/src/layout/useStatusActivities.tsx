import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useOptionalLibrary } from "../library/LibraryContext";
import { nativeWorkload } from "../app/workloadProfile";
import { notifyCloudBackfillSupervisor } from "../app/useCloudBackfillSupervisor";
import { useWorkloadProfile } from "../app/workloadProfile";
import { dismissPublication, publicationLabel, publicationProgressText, type PublicationJob } from "../library/publicationJobs";
import { dismissVaultImport, vaultImportResultText, type VaultImportJob } from "../external-vault/vaultImportJob";
import { dismissVaultExport, vaultExportResultText, type VaultExportJob } from "../external-vault/vaultExportJob";
import type { AutoTagInboxStatus } from "../autotags/useAutoTagInboxStatus";
import type { StatusCenterProps, StatusWork } from "./StatusCenter";
import type { ActivityItem } from "./activityTimeline";
import { dismissNativeActivity, useActivityRegistry } from "./useActivityRegistry";
import { useActivitySections } from "./ActivityList";
import { Button } from "../shared/ui/Button";

type Inputs = Pick<StatusCenterProps, "characterAutomation" | "works" | "retryWork" | "dismissWork" | "openExisting" | "progress" | "similarityIndex" | "cloud"> & {
  publicationJobs: PublicationJob[]; vaultImport: VaultImportJob | null; vaultExport: VaultExportJob | null;
  inbox: { status: AutoTagInboxStatus | null; dismiss(): void }; go: StatusCenterProps["onNavigate"];
};

/** Project existing result owners into the same rows as native background work. */
export function useStatusActivities(input: Inputs) {
  const native = useActivityRegistry();
  const gateway = useOptionalLibrary()?.gateway;
  const { restricted } = useWorkloadProfile();
  const [characterPaused, setCharacterPaused] = useState<boolean | null>(null);
  const [cloudPaused, setCloudPaused] = useState<boolean | null>(null);
  const [cloudError, setCloudError] = useState<string | null>(null);
  const [videoControlError, setVideoControlError] = useState<string | null>(null);
  const [dismissed, setDismissed] = useState(new Set<string>());
  const hiddenNative = useRef(new Set<string>());
  const character = input.characterAutomation;
  useEffect(() => setCharacterPaused(null), [character.paused]);
  useEffect(() => setCloudPaused(null), [input.cloud?.progress?.controlState]);
  const nativeCharacters = native.filter(row => row.pauseGroup === "character" && row.state !== "done" && row.state !== "failed");
  const paused = characterPaused ?? (nativeCharacters.length ? nativeCharacters.some(row => row.pausedReason === "일시 정지됨") : character.paused);
  const pauseCharacter = () => {
    setCharacterPaused(!paused);
    (paused ? character.resumeHistoryRefresh : character.pauseHistoryRefresh)();
  };
  const cloudPause = async () => {
    const next = !(cloudPaused ?? (input.cloud?.progress?.controlState === "paused"));
    setCloudPaused(next); setCloudError(null);
    try {
      if (gateway?.cloudBackfillSetControlState) await gateway.cloudBackfillSetControlState(next ? "paused" : "running");
      else if (nativeWorkload()) await invoke("cloud_backfill_set_control_state", { state: next ? "paused" : "running" });
      notifyCloudBackfillSupervisor();
    } catch (error) { setCloudPaused(null); setCloudError(String(error)); }
  };
  const rows: ActivityItem[] = [];
  const pauseVideo = async (row: typeof native[number]) => {
    const scanId = row.key.replace(/^video-similarity:/, "");
    setVideoControlError(null);
    try {
      await invoke(row.state === "paused" || row.state === "queued" ? "resume_video_similarity_scan" : "cancel_video_similarity_scan", { scanId });
    } catch (error) { setVideoControlError(String(error)); }
  };
  const kinds = new Set<string>();
  const representedNative = new Set<string>();
  const resultKinds = new Set(["publication_catalog", "publication_characters", "vault_import", "vault_export"]);
  const nativeOwned = new Set(native.filter(row => ["character_fresh", "character_reconsideration", "character_history", "similarity", "cloud_upload"].includes(row.kind)).map(row => row.kind));
  const add = (row: ActivityItem) => {
    if (nativeOwned.has(row.kind)) return;
    kinds.add(row.kind);
    if (resultKinds.has(row.kind)) {
      const matches = native.filter(item => item.kind === row.kind && (item.state === "running") === (row.state === "running"));
      const match = matches.sort((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0))[0];
      if (match) {
        representedNative.add(match.id);
        const close = row.dismiss;
        row = { ...row, id: match.id, startedAt: match.startedAt, finishedAt: match.finishedAt,
          dismiss: () => { hiddenNative.current.add(match.id); void dismissNativeActivity(match.id).catch(() => undefined); close?.(); } };
      }
    }
    rows.push(row);
  };
  const dismiss = (id: string) => setDismissed(current => new Set([...current, id]));
  const dismissKind = (kind: string, action: () => void) => () => {
    if (!resultKinds.has(kind)) native.filter(row => row.kind === kind).forEach(row => { hiddenNative.current.add(row.id); void dismissNativeActivity(row.id).catch(() => undefined); });
    action();
  };
  for (const work of input.works ?? []) {
    const failed = work.status === "failed" || (work.status === "completed" && work.failures.length > 0);
    const kind = work.kind === "metadata_import" ? "ingestion" : work.kind;
    add({ id: `local-work:${work.id}`, kind, label: work.kind === "drag_out" ? "탐색기로 복사" : work.kind === "preparation" ? "미리보기 준비" : work.kind === "metadata_import" ? "메타데이터 폴더 가져오기" : "파일 가져오기",
      state: failed ? "failed" : work.status === "running" ? "running" : "done", done: work.completed, total: work.total,
      detail: work.status !== "running" ? workSummary(work) : null,
      error: failed ? work.failures.map(f => `${f.fileName}: ${f.message}`).join(" · ") || "작업 실패" : null,
      retry: failed ? () => input.retryWork?.(work.id) : undefined,
      dismiss: dismissKind(kind, () => input.dismissWork?.(work.id)),
      result: work.status !== "running" ? <>
        <p>{workSummary(work)}</p>
        {work.exactDuplicates.map(item => <Button size="sm" variant="ghost" key={`${item.fileName}:${item.existingAssetId}`} onClick={() => input.openExisting?.(item.existingAssetId)}>{item.fileName} 기존 자산 열기</Button>)}
        {work.reviewPending.length > 0 && <Button size="sm" variant="ghost" onClick={() => input.go({ kind: "similarity_review" })}>검토 대기 {work.reviewPending.length}개 열기</Button>}
        {work.failures.map((failure, index) => <p key={index}>{failure.fileName}: {failure.message}</p>)}
        {work.kind === "metadata_import" && <>
          {work.skipped.map((item, index) => <p key={index}>{item.fileName}: {item.message}</p>)}
          <Button size="sm" onClick={() => input.retryWork?.(work.id)}>폴더 다시 가져오기</Button>
        </>}
      </> : undefined });
  }
  if (input.progress && !(input.works ?? []).some(work => work.kind === "ingestion" && work.status === "running")) {
    add({ id: "local-drop", kind: "ingestion", label: "파일 가져오기", state: "running", done: input.progress.current, total: input.progress.total });
  }
  for (const job of input.publicationJobs) add({ id: `local-publish:${job.kind}`, kind: `publication_${job.kind}`, label: publicationLabel(job.kind), state: job.error ? "failed" : job.running ? "running" : "done",
    done: job.progress.completed, total: job.progress.total,
    countText: job.progress.unit === "bytes" ? `${(job.progress.completed / 1048576).toFixed(1)}${job.progress.total == null ? "" : ` / ${(job.progress.total / 1048576).toFixed(1)}`} MB` : undefined,
    detail: job.running ? publicationProgressText(job.progress).split(" · ")[0] : job.message, error: job.error ? job.message : null,
    dismiss: dismissKind(`publication_${job.kind}`, () => dismissPublication(job.kind)) });
  for (const [kind, label, job, close, result] of [
    ["vault_import", "비밀 보관함 가져오기", input.vaultImport, dismissVaultImport, input.vaultImport && vaultImportResultText(input.vaultImport)],
    ["vault_export", "비밀 보관함 내보내기", input.vaultExport, dismissVaultExport, input.vaultExport && vaultExportResultText(input.vaultExport)],
  ] as const) if (job) add({ id: `local-${kind}`, kind, label,
    state: job.error || (!job.running && (("report" in job ? job.report?.failed : job.progress?.failed) ?? 0) > 0) ? "failed" : job.running ? "running" : "done",
    done: job.progress?.processed ?? 0, total: job.progress?.total, detail: job.running ? null : result,
    error: job.error || (!job.running && (("report" in job ? job.report?.failed : job.progress?.failed) ?? 0) > 0 ? result : null), dismiss: dismissKind(kind, close) });
  if (input.inbox.status) add({ id: "local-inbox", kind: "nightly_import", label: "매일 자동 가져오기", state: input.inbox.status.error ? "failed" : "done", done: 0,
    detail: input.inbox.status.message, error: input.inbox.status.error ? input.inbox.status.message : null, dismiss: input.inbox.dismiss });
  const work = character.activeWork;
  const characterReason = paused ? "일시 정지됨" : restricted ? "절약 모드" : null;
  if (character.persistentError) add({ id: "local-character-error", kind: "character_error", label: "캐릭터 분석 오류", state: "failed", done: 0, error: character.persistentError, retry: () => void character.setupRuntime(), dismiss: character.dismissError });
  for (const [kind, label, remaining, active] of [
    ["character_fresh", work?.cause === "manual_scan" ? "수동 분석" : "새 이미지 분석", work?.freshRemaining ?? 0, Boolean(work?.active && work.cause !== "reconsideration")],
    ["character_reconsideration", "캐릭터 재검토", work?.reconsiderationRemaining ?? 0, Boolean(work?.active && work.cause === "reconsideration")],
  ] as const) if (remaining > 0 || active) add({ id: `local-${kind}`, kind, label,
    state: paused || (restricted && kind === "character_reconsideration") ? "paused" : active ? "running" : "queued", done: 0, countText: `${remaining.toLocaleString()}개 남음`,
    detail: active ? [work?.seriesName, work?.targetName].filter(Boolean).join(" / ") || null : null,
    pauseGroup: "character", pausedReason: paused || kind === "character_reconsideration" ? characterReason : null, pause: pauseCharacter });
  for (const refresh of character.historyRefreshes ?? []) add({ id: `local-history:${refresh.targetId}`, kind: "character_history", label: "과거 미분류 갱신", state: refresh.state === "failed" ? "failed" : refresh.state === "completed" ? "done" : characterReason ? "paused" : refresh.state === "running" ? "running" : "queued",
    done: refresh.processed, total: refresh.total, countText: refresh.total == null ? `${refresh.processed}개 처리 · ${refresh.remaining}개 대기` : `${refresh.processed.toLocaleString()} / ${refresh.total.toLocaleString()}`,
    detail: `${refresh.seriesName} / ${refresh.targetName}`, error: refresh.state === "failed" ? `${refresh.seriesName} / ${refresh.targetName} · 캐릭터에서 다시 갱신해 주세요` : null,
    pauseGroup: "character", pausedReason: characterReason, pause: pauseCharacter, dismiss: () => dismiss(`local-history:${refresh.targetId}`) });
  if (character.historyRefreshActive && !(character.historyRefreshes?.length)) add({ id: "local-history", kind: "character_history", label: "과거 미분류 갱신", state: characterReason ? "paused" : "running", done: 0, pauseGroup: "character", pausedReason: characterReason, pause: pauseCharacter });
  const similarity = input.similarityIndex;
  if (similarity && (similarity.running || similarity.failed || similarity.message)) add({ id: "local-similarity", kind: "similarity", label: "유사 이미지 준비", state: similarity.message || (!similarity.running && similarity.failed > 0) ? "failed" : restricted ? "queued" : "running", done: 0, countText: `${similarity.remaining.toLocaleString()}개 남음`, pausedReason: restricted ? "절약 모드" : null,
    error: similarity.message || (!similarity.running && similarity.failed > 0 ? `실패 ${similarity.failed}개` : null), dismiss: () => dismiss("local-similarity") });
  const cloud = input.cloud?.progress;
  if (cloud) {
    const remaining = cloud.queued + cloud.preparing + cloud.uploading + cloud.committing;
    if (remaining > 0) {
      const reason = (cloudPaused ?? (cloud.controlState === "paused")) ? "일시 정지됨" : cloud.replicationEnabled === false ? "동기화 꺼짐" : cloud.syncHeld ? "송신 보류" : null;
      add({ id: "local-cloud", kind: "cloud_upload", label: "클라우드 업로드", state: reason ? "paused" : "running", done: cloud.completed,
        total: cloud.totalAssets, countText: `${remaining.toLocaleString()}개 남음`, pausedReason: reason, pauseGroup: "cloud", pause: () => void cloudPause() });
    }
  }
  if (cloudError) add({ id: "local-cloud-control-error", kind: "cloud_upload_control_problem", label: "클라우드 업로드 제어 문제", state: "failed", done: 0,
    error: cloudError, retry: () => void cloudPause(), dismiss: () => setCloudError(null) });
  if (videoControlError) add({ id: "local-video-control-error", kind: "video_similarity_control_problem", label: "영상 유사 검사 제어 문제", state: "failed", done: 0,
    error: videoControlError, dismiss: () => setVideoControlError(null) });
  // Native rows represented by result owners never return as duplicate results after dismissal.
  native.forEach(row => { if (kinds.has(row.kind) && !resultKinds.has(row.kind)) hiddenNative.current.add(row.id); });
  for (const row of native) {
    if (hiddenNative.current.has(row.id) || representedNative.has(row.id)) continue;
    const saverDeferred = restricted && ["similarity", "character_reconsideration", "character_history", "reference_reinforcement", "character_claude", "character_augmentation", "character_shadow", "character_shadow_backfill"].includes(row.kind);
    rows.push({ ...row,
      label: row.kind === "character_fresh" && character.activeWork?.cause === "manual_scan" ? "수동 분석" : row.label,
      countText: row.kind.startsWith("transfer_") && row.total != null ? `${(row.done / 1048576).toFixed(1)} / ${(row.total / 1048576).toFixed(1)} MB`
        : row.kind === "catalog_refresh" ? `${row.done.toLocaleString()}페이지`
        : row.detail?.match(/^\d+개 (남음|처리 중)$/) ? row.detail.replace(/^\d+/, value => Number(value).toLocaleString()) : undefined,
      detail: ["character_fresh", "character_reconsideration"].includes(row.kind) && row.state === "running" && character.activeWork?.active
        ? [character.activeWork.seriesName, character.activeWork.targetName].filter(Boolean).join(" / ") || null
        : row.detail?.match(/^\d+개 (남음|처리 중)$/) ? null
          : row.kind.startsWith("publication_") && row.state === "done" ? null : row.kind === "catalog_refresh" ? row.detail?.replace(/ · \d+페이지$/, "") : row.detail,
      pause: row.pauseGroup === "character" ? pauseCharacter : row.pauseGroup === "cloud" ? () => void cloudPause() : row.kind === "video_similarity" && row.pausable ? () => void pauseVideo(row) : undefined,
      state: row.state === "failed" || row.state === "done" ? row.state : row.pauseGroup === "character" && paused ? "paused" : saverDeferred ? "queued" : row.pauseGroup === "cloud" && cloudPaused !== null ? cloudPaused ? "paused" : "queued" : row.state,
      pausedReason: row.state === "done" || row.state === "failed" ? row.pausedReason : row.pauseGroup === "character" && paused ? "일시 정지됨" : saverDeferred ? row.pausedReason ?? "절약 모드" : row.pauseGroup === "cloud" && cloudPaused !== null ? cloudPaused ? "일시 정지됨" : null : row.pausedReason,
      dismiss: () => { dismiss(row.id); void dismissNativeActivity(row.id).catch(() => undefined); },
      open: row.kind.startsWith("transfer_") ? () => input.go({ kind: "exchange" }) : undefined,
    });
  }
  return useActivitySections(rows.filter(row => !dismissed.has(row.id)));
}

function workSummary(work: StatusWork) {
  if (work.kind === "preparation") return work.status === "failed" ? "미리보기 준비 실패" : "미리보기 준비 완료";
  if (work.kind === "drag_out") return `${work.completed.toLocaleString()}개 복사 완료`;
  return [work.kind === "metadata_import" ? `폴더 생성 ${work.foldersCreated} · 경로 재사용 ${work.pathsReused}` : null,
    `추가 ${work.added} · 중복 ${work.exactDuplicates.length} · 검토 대기 ${work.reviewPending.length}`,
    work.kind === "metadata_import" ? `건너뜀 ${work.skipped.length}` : null, `실패 ${work.failures.length}`].filter(Boolean).join(" · ");
}
