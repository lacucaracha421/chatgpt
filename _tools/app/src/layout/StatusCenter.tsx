import { useAutoTagInboxStatus } from "../autotags/useAutoTagInboxStatus";
import { SectionLabel } from "../shared/ui/SectionLabel";
import * as RadixDialog from "@radix-ui/react-dialog";
import { ChartBarIcon, ChevronRightIcon, InboxIcon, Square2StackIcon, XMarkIcon } from "@heroicons/react/24/outline";
import { useState, type ReactNode } from "react";
import type { AssetBrowserStatus } from "../assets/AssetBrowser";
import { tabletWaitText, type CloudSyncStatus } from "../app/useCloudProblems";
import { displayCount } from "../shared/displayDate";
import { LightweightModeToggle } from "../app/WorkloadControls";
import { nativeWorkload } from "../app/workloadProfile";
import type { QuietCharacterAutomationState } from "../characters/useCharacterAutomation";
import { useVaultExportJob } from "../external-vault/vaultExportJob";
import { useVaultImportJob } from "../external-vault/vaultImportJob";
import type { MetadataImportWork } from "../ingestion/metadataImport";
import type { DropProgress, IngestionWork } from "../ingestion/useFileDrop";
import { usePublicationJobs } from "../library/publicationJobs";
import type { AssetView, AuthoritySyncHealth } from "../library/types";
import { useBackHandler } from "../shared/navigation/BackNavigation";
import type { SimilarityIndexState } from "../similarity/useSimilarityIndex";
import { ActivityList } from "./ActivityList";
import { useStatusActivities } from "./useStatusActivities";
import "./StatusCenter.css";

export type StatusWork = IngestionWork | MetadataImportWork;

export type StatusCenterProps = {
  characterAutomation: QuietCharacterAutomationState;
  progress: DropProgress | null;
  similarityIndex?: SimilarityIndexState;
  browserStatus?: AssetBrowserStatus;
  dropEnabled?: boolean;
  works?: StatusWork[];
  retryWork?: (workId: string) => void;
  dismissWork?: (workId: string) => void;
  openExisting?: (assetId: string) => void;
  cloud?: CloudSyncStatus;
  /** Local server-sync health; null until read or when the gateway has none. */
  authorityHealth?: AuthoritySyncHealth | null;
  reviewCount?: number;
  /** Null until the count has been read; it is refreshed whenever the panel opens. */
  unsortedCount?: number | null;
  onOpenChange?: (open: boolean) => void;
  onNavigate: (view: AssetView) => void;
  /** The 연결 block; `go` closes the panel and navigates. */
  connections?: (go: (view: AssetView) => void) => ReactNode;
};

const noop = () => undefined;

/**
 * One titlebar status indicator and panel: sync state, running and finished work,
 * non-empty review queues and the instant lightweight-mode switch.
 */
export function StatusCenter({
  characterAutomation,
  progress,
  similarityIndex,
  works = [],
  retryWork = noop,
  dismissWork = noop,
  openExisting = noop,
  cloud,
  authorityHealth = null,
  reviewCount = 0,
  unsortedCount = null,
  onOpenChange,
  onNavigate,
  connections,
}: StatusCenterProps) {
  const [open, setOpenState] = useState(false);
  const setOpen = (next: boolean) => { setOpenState(next); onOpenChange?.(next); };
  useBackHandler(() => setOpen(false), 90, open);
  const publicationJobs = Object.values(usePublicationJobs()).filter(Boolean);
  const inbox = useAutoTagInboxStatus();
  const vaultImport = useVaultImportJob().job;
  const vaultExport = useVaultExportJob();

  const manualCharacterWork = Boolean(characterAutomation.activeWork?.cause === "manual_scan"
    && (characterAutomation.activeWork.active || characterAutomation.activeWork.freshRemaining > 0));
  const characterFailures = (characterAutomation.historyRefreshes ?? []).filter(refresh => refresh.state === "failed").length;
  const characterCounted = Boolean(
    characterAutomation.persistentError || characterAutomation.historyRefreshActive || manualCharacterWork || characterFailures,
  );
  const visibleWorks = works.filter((work) => work.kind !== "drag_out" || work.status !== "completed");
  const userWorks = visibleWorks.filter(work => work.kind !== "preparation");
  const runningIngestion = visibleWorks.some((work) => work.kind === "ingestion" && work.status === "running");
  // A running file import is described once, by its work row, not also by the drop progress line.
  const libraryProgress = runningIngestion ? null : progress;
  const libraryVisible = Boolean(libraryProgress || similarityIndex?.failed || similarityIndex?.message);
  const cloudProblems = cloud?.problemCount ?? 0;
  const authority = authoritySyncSummary(authorityHealth);

  const activeCount = publicationJobs.filter((job) => job.running).length
    + Number(Boolean(vaultImport?.running))
    + Number(Boolean(vaultExport?.running))
    + Number(characterAutomation.historyRefreshActive)
    + Number(manualCharacterWork)
    + Number(libraryProgress !== null)
    + userWorks.filter((work) => work.status === "running").length;
  const problemCount = Number(Boolean(inbox.status?.error)) + publicationJobs.filter((job) => job.error).length
    + Number(Boolean(vaultImport?.error))
    + Number(Boolean(vaultExport?.error))
    + Number(Boolean(characterAutomation.persistentError))
    + characterFailures
    + Number(Boolean(similarityIndex?.failed || similarityIndex?.message))
    + visibleWorks.filter((work) => work.status === "failed" || (work.status === "completed" && work.failures.length > 0)).length
    + cloudProblems
    + authority.problemCount;
  const workCount = publicationJobs.length + Number(Boolean(vaultImport)) + Number(Boolean(vaultExport))
    + Number(characterCounted) + Number(libraryVisible) + userWorks.length;

  const state = problemCount > 0 ? "attention" : activeCount > 0 ? "active" : workCount > 0 ? "available" : reviewCount > 0 ? "queue" : "idle";
  const text = { attention: `문제 ${problemCount}`, active: `작업 ${activeCount}`, available: `결과 ${workCount}`, queue: `유사 ${reviewCount}`, idle: "상태" }[state];
  const label = {
    attention: `상태 · 문제 ${problemCount}개`,
    active: `상태 · 작업 ${activeCount}개 진행 중`,
    available: `상태 · 결과 ${workCount}개`,
    queue: `상태 · 유사 이미지 검토 ${reviewCount}개 대기`,
    idle: "상태",
  }[state];
  const description = [
    state !== "active" && activeCount > 0 ? `작업 ${activeCount}개 진행 중` : null,
    state !== "queue" && reviewCount > 0 ? `유사 이미지 검토 ${reviewCount}개 대기` : null,
  ].filter(Boolean).join(" · ") || undefined;

  const go = (view: AssetView) => { setOpen(false); onNavigate(view); };
  const activities = useStatusActivities({ characterAutomation, progress, similarityIndex, works, retryWork, dismissWork,
    openExisting: id => { setOpen(false); openExisting(id); }, cloud, publicationJobs, vaultImport, vaultExport, inbox, go });
  const queues = [
    { id: "review", label: "유사 이미지 검토", count: reviewCount, icon: <Square2StackIcon />, view: { kind: "similarity_review" } as const },
    { id: "unsorted", label: "미분류", count: unsortedCount ?? 0, icon: <InboxIcon />, view: { kind: "unsorted" } as const },
  ].filter((queue) => queue.count > 0);

  return <RadixDialog.Root modal={false} open={open} onOpenChange={setOpen}>
    <RadixDialog.Trigger asChild>
      <button type="button" className="status-center__trigger" data-state-tone={state} aria-label={label} aria-description={description}>
        {state === "active" ? <span className="status-center__spinner" aria-hidden="true" /> : <ChartBarIcon aria-hidden="true" />}
        <span className="status-center__trigger-text">{text}</span>
      </button>
    </RadixDialog.Trigger>
    <RadixDialog.Portal>
      <RadixDialog.Content className="ui-anchored-panel status-center__panel" aria-modal={false} aria-describedby={undefined}
        onEscapeKeyDown={(event) => { event.preventDefault(); event.stopPropagation(); setOpen(false); }}>
        <div className="ui-anchored-panel__head">
          <RadixDialog.Title>상태</RadixDialog.Title>
          <RadixDialog.Close className="ui-button ui-button--icon ui-button--ghost" aria-label="상태 닫기"><XMarkIcon aria-hidden="true" /></RadixDialog.Close>
        </div>
        <div className="ui-anchored-panel__body status-center__body">
          {cloud && <SyncBlock cloud={cloud} onOpenSettings={() => go({ kind: "settings", section: "connection" })} />}
          <AuthoritySyncBlock summary={authority} />
          {connections?.(go)}
          <StatusBlock title="작업">
            <ActivityList sections={activities} />
          </StatusBlock>
          {queues.length > 0 && <StatusBlock title="확인할 것">
            {queues.map((queue) => <button key={queue.id} type="button" className="status-center__queue" onClick={() => go(queue.view)}>
              <span className="status-center__queue-icon" aria-hidden="true">{queue.icon}</span>
              <span className="status-center__queue-label">{queue.label}</span>
              <span className="status-center__queue-count">{queue.count.toLocaleString()}</span>
              <ChevronRightIcon aria-hidden="true" className="status-center__queue-arrow" />
            </button>)}
          </StatusBlock>}
          <LightweightBlock />
        </div>
      </RadixDialog.Content>
    </RadixDialog.Portal>
  </RadixDialog.Root>;
}

function StatusBlock({ title, children }: { title: string; children: ReactNode }) {
  return <section className="status-center__block" aria-label={title}>
    <SectionLabel as="h3" className="status-center__heading" title={title} />
    {children}
  </section>;
}

function SyncBlock({ cloud, onOpenSettings }: { cloud: CloudSyncStatus; onOpenSettings: () => void }) {
  const { problemCount, progress } = cloud;
  if (problemCount > 0) {
    return <StatusBlock title="동기화">
      <div className="status-center__sync" data-tone="problem" role="alert">
        <span className="status-center__dot" aria-hidden="true" />
        <span>동기화 문제 {problemCount.toLocaleString()}개</span>
        <button type="button" className="ui-button ui-button--sm ui-button--ghost" onClick={onOpenSettings}>동기화 설정 열기</button>
      </div>
    </StatusBlock>;
  }
  if (!progress) return null;
  const remaining = progress.queued + progress.preparing + progress.uploading + progress.committing;
  if (progress.replicationEnabled !== false && progress.controlState !== "paused") return null;
  const tone = "off";
  const text = progress.replicationEnabled === false ? "클라우드 동기화 꺼짐"
    : remaining > 0 ? `동기화 일시 정지 · ${remaining.toLocaleString()}개 대기` : "동기화 일시 정지";
  return <StatusBlock title="동기화">
    <div className="status-center__sync" data-tone={tone} role="status">
      <span className="status-center__dot" aria-hidden="true" />
      <span>{text}</span>
    </div>
  </StatusBlock>;
}

// Each line says what happened from the user's side and, when there is something to do, what to do.
const LANE_FAILURE_TEXT: Record<string, string> = {
  credential_store_locked: "비밀번호 보관함이 잠겨 동기화하지 못함",
  credential_store_unavailable: "비밀번호 보관함을 쓸 수 없어 동기화하지 못함",
  credential_store_failed: "비밀번호 보관함 오류로 동기화하지 못함",
  credential_not_configured: "서버 연결 키 없음 · 설정에서 입력",
  unauthorized: "서버가 연결 키를 거부함 · 설정에서 키 확인",
  network: "서버에 연결할 수 없음 · 자동 재시도",
  timeout: "서버 응답 없음 · 자동 재시도",
  server: "서버 오류로 동기화하지 못함 · 자동 재시도",
  identity_or_integrity_conflict: "서버 파일이 이 PC 파일과 맞지 않아 받지 못함",
};

/** Why a change from this PC was cancelled; the server's state stays. */
const DROP_REASON_TEXT: Record<string, string> = {
  assetTrashedBeforeUpload: "업로드 전에 휴지통으로 옮김",
  assetDeleted: "이 PC에서 파일이 삭제됨",
  assetPurged: "파일을 영구 삭제함",
  assetTombstoned: "서버에서 영구 삭제됨",
  assetNotFound: "파일이 서버에 없음",
  albumDeleted: "앨범이 삭제됨",
  albumNotFound: "앨범이 삭제됨",
  classificationNotFound: "분류가 삭제됨",
  invalidAlbumMembership: "앨범에 넣을 파일이 서버에 없음",
  invalidClassificationAssignment: "분류할 파일이 서버에 없음",
  lifecycleTransitionRefused: "서버에서 허용하지 않는 변경",
  operationConflict: "서버에서 처리하지 못함",
  revisionConflict: "다른 기기에서 먼저 바뀜",
  dependencyDropped: "앞선 변경이 취소됨",
  workTrashed: "작품이 휴지통에 있음",
  similarityKeptByTabletDecision: "태블릿 유사 이미지 검토에서 남기기로 함",
  epochChanged: "서버 라이브러리가 새로 설정됨",
};
const DROP_REASON_FALLBACK = "서버 내용을 따름";

const EXCLUSION_SKIP_TEXT: Record<string, string> = {
  targetMissing: "캐릭터가 삭제됨",
  assetMissing: "이미지가 휴지통에 있거나 삭제됨",
  assetChanged: "이미지 내용이 바뀜",
  protectedReference: "캐릭터의 레퍼런스 이미지",
};

export type AuthoritySyncSummary = {
  problemCount: number;
  problems: string[];
  notes: string[];
};

/**
 * Blocked intents and failing lanes are problems; waiting and dropped intents are
 * informational (they resolve or were settled by the server state).
 */
export function authoritySyncSummary(health: AuthoritySyncHealth | null): AuthoritySyncSummary {
  if (!health) return { problemCount: 0, problems: [], notes: [] };
  const problems: string[] = [];
  let problemCount = 0;
  const blocked = health.albums.blockedCount + health.classifications.blockedCount + (health.collections?.blockedCount ?? 0);
  if (blocked > 0) {
    problemCount += blocked;
    problems.push(`서버가 거절해 멈춘 변경 ${displayCount(blocked, "개")}`);
  }
  if (health.assets.stopped) {
    problemCount += 1;
    problems.push("휴지통·복원 변경을 보내지 못함 · 자동 재시도");
  }
  const materializationFailures = health.assets.materializationFailures ?? 0;
  if (materializationFailures > 0) {
    problemCount += materializationFailures;
    problems.push(`서버에서 받지 못한 파일 ${displayCount(materializationFailures, "개")}`);
  }
  // Both lanes share one credential and connection, so one cause is reported once.
  const failures = new Set([health.authorityPassFailure?.code, health.assetLaneFailure?.code].filter((code): code is string => Boolean(code)));
  failures.forEach((code) => problems.push(LANE_FAILURE_TEXT[code] ?? "서버와 동기화하지 못함"));
  problemCount += failures.size;

  const notes: string[] = [];
  if (health.assets.held || health.authorityHeld) notes.push("보내기 보류 중 · 이 PC의 변경은 보류를 풀면 보냄");
  const tabletWait = health.syncHold?.held ? health.syncHold.tabletWait : null;
  if (tabletWait && tabletWait.count > 0) notes.push(tabletWaitText(tabletWait.count));
  const waiting = health.albums.waitingCount + health.classifications.waitingCount;
  if (waiting > 0) notes.push(`업로드가 끝나면 보낼 변경 ${displayCount(waiting, "개")}`);
  const dropped = health.albums.droppedCount + health.classifications.droppedCount + health.assets.rejectedCount + (health.collections?.droppedCount ?? 0);
  if (dropped > 0) {
    const latest = [health.albums, health.classifications, ...(health.collections ? [health.collections] : [])]
      .filter((domain) => domain.droppedCount > 0 && domain.lastDropReason)
      .sort((a, b) => (b.lastDroppedAt ?? "").localeCompare(a.lastDroppedAt ?? ""))[0]?.lastDropReason
      ?? health.assets.rejectedReason;
    const reason = latest ? DROP_REASON_TEXT[latest] ?? DROP_REASON_FALLBACK : null;
    notes.push(`취소된 변경 ${displayCount(dropped, "개")}${reason ? ` · ${reason}` : ""}`);
  }
  for (const asset of health.assets.rejectedAssets ?? []) {
    notes.push(`휴지통·복원 취소됨 · ${asset.name} · ${DROP_REASON_TEXT[asset.reason] ?? DROP_REASON_FALLBACK}`);
  }
  const skipped = health.characterExclusions?.skippedCount ?? 0;
  if (skipped > 0) {
    const code = health.characterExclusions.lastSkipReason;
    const reason = code ? EXCLUSION_SKIP_TEXT[code] : undefined;
    notes.push(`태블릿의 캐릭터 제외 ${displayCount(skipped, "개")} 적용 안 됨${reason ? ` · ${reason}` : ""}`);
  }
  return { problemCount, problems, notes };
}

function AuthoritySyncBlock({ summary }: { summary: AuthoritySyncSummary }) {
  if (summary.problems.length === 0 && summary.notes.length === 0) return null;
  return <StatusBlock title="서버 동기화">
    <div className="status-center__sync-list" role="status">
      {summary.problems.map((text) => <div key={text} className="status-center__sync" data-tone="problem">
        <span className="status-center__dot" aria-hidden="true" />
        <span>{text}</span>
      </div>)}
      {summary.notes.map((text) => <div key={text} className="status-center__sync" data-tone="note">
        <span className="status-center__dot" aria-hidden="true" />
        <span>{text}</span>
      </div>)}
    </div>
  </StatusBlock>;
}

function LightweightBlock() {
  if (!nativeWorkload()) return null;
  return <StatusBlock title="이 PC"><LightweightModeToggle /></StatusBlock>;
}
