import * as RadixDialog from "@radix-ui/react-dialog";
import { ChevronRightIcon, XMarkIcon } from "@heroicons/react/24/outline";
import { useState, type ReactNode } from "react";
import type { AssetBrowserStatus } from "../assets/AssetBrowser";
import type { CloudSyncStatus } from "../app/useCloudProblems";
import { LightweightModeToggle } from "../app/WorkloadControls";
import { nativeWorkload } from "../app/workloadProfile";
import { CharacterAutomationStatus } from "../characters/CharacterAutomationStatus";
import type { QuietCharacterAutomationState } from "../characters/useCharacterAutomation";
import { VaultExportStatus, VaultImportStatus } from "../external-vault/VaultImportStatus";
import { useVaultExportJob } from "../external-vault/vaultExportJob";
import { useVaultImportJob } from "../external-vault/vaultImportJob";
import type { MetadataImportWork } from "../ingestion/metadataImport";
import type { DropProgress, IngestionWork } from "../ingestion/useFileDrop";
import { WorkTray } from "../ingestion/WorkTray";
import { usePublicationJobs } from "../library/publicationJobs";
import type { AssetView } from "../library/types";
import { useBackHandler } from "../shared/navigation/BackNavigation";
import { ActivityIcon, InboxIcon, PhotoIcon } from "../shared/ui/ArchiveIcons";
import type { SimilarityIndexState } from "../similarity/useSimilarityIndex";
import { PublicationStatus } from "./PublicationStatus";
import { StatusBar } from "./StatusBar";
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
  reviewCount?: number;
  /** Null until the count has been read; it is refreshed whenever the panel opens. */
  unsortedCount?: number | null;
  onOpenChange?: (open: boolean) => void;
  onNavigate: (view: AssetView) => void;
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
  browserStatus = { loadedCount: 0, selectedAsset: null, loading: false },
  dropEnabled = false,
  works = [],
  retryWork = noop,
  dismissWork = noop,
  openExisting = noop,
  cloud,
  reviewCount = 0,
  unsortedCount = null,
  onOpenChange,
  onNavigate,
}: StatusCenterProps) {
  const [open, setOpenState] = useState(false);
  const setOpen = (next: boolean) => { setOpenState(next); onOpenChange?.(next); };
  useBackHandler(() => setOpen(false), 90, open);
  const publicationJobs = Object.values(usePublicationJobs()).filter(Boolean);
  const vaultImport = useVaultImportJob().job;
  const vaultExport = useVaultExportJob();

  const freshCharacterWork = Boolean(characterAutomation.activeWork && (characterAutomation.activeWork.freshRemaining > 0
    || (characterAutomation.activeWork.active && characterAutomation.activeWork.cause !== "reconsideration")));
  const characterFailures = (characterAutomation.historyRefreshes ?? []).filter(refresh => refresh.state === "failed").length;
  const characterVisible = Boolean(
    characterAutomation.persistentError || characterAutomation.historyRefreshActive || freshCharacterWork || characterFailures,
  );
  const visibleWorks = works.filter((work) => work.kind !== "drag_out" || work.status !== "completed");
  const runningIngestion = visibleWorks.some((work) => work.kind === "ingestion" && work.status === "running");
  // A running file import is described once, by its work row, not also by the drop progress line.
  const libraryProgress = runningIngestion ? null : progress;
  const libraryVisible = Boolean(libraryProgress || similarityIndex?.running || similarityIndex?.failed || similarityIndex?.message);
  const cloudProblems = cloud?.problemCount ?? 0;

  const activeCount = publicationJobs.filter((job) => job.running).length
    + Number(Boolean(vaultImport?.running))
    + Number(Boolean(vaultExport?.running))
    + Number(characterAutomation.historyRefreshActive)
    + Number(freshCharacterWork)
    + Number(libraryProgress !== null)
    + Number(Boolean(similarityIndex?.running))
    + visibleWorks.filter((work) => work.status === "running").length;
  const problemCount = publicationJobs.filter((job) => job.error).length
    + Number(Boolean(vaultImport?.error))
    + Number(Boolean(vaultExport?.error))
    + Number(Boolean(characterAutomation.persistentError))
    + characterFailures
    + Number(Boolean(similarityIndex?.failed || similarityIndex?.message))
    + visibleWorks.filter((work) => work.status === "failed" || (work.status === "completed" && work.failures.length > 0)).length
    + cloudProblems;
  const workCount = publicationJobs.length + Number(Boolean(vaultImport)) + Number(Boolean(vaultExport))
    + Number(characterVisible) + Number(libraryVisible) + visibleWorks.length;

  const state = problemCount > 0 ? "attention" : activeCount > 0 ? "active" : workCount > 0 ? "available" : reviewCount > 0 ? "queue" : "idle";
  const text = { attention: `문제 ${problemCount}`, active: `작업 ${activeCount}`, available: `결과 ${workCount}`, queue: `확인 ${reviewCount}`, idle: "상태" }[state];
  const label = {
    attention: `상태 · 문제 ${problemCount}개`,
    active: `상태 · 작업 ${activeCount}개 진행 중`,
    available: `상태 · 결과 ${workCount}개`,
    queue: `상태 · 확인 ${reviewCount}개 대기`,
    idle: "상태",
  }[state];
  const description = [
    state !== "active" && activeCount > 0 ? `작업 ${activeCount}개 진행 중` : null,
    state !== "queue" && reviewCount > 0 ? `유사 검토 ${reviewCount}개 대기` : null,
  ].filter(Boolean).join(" · ") || undefined;

  const go = (view: AssetView) => { setOpen(false); onNavigate(view); };
  const queues = [
    { id: "review", label: "유사 이미지 검토", count: reviewCount, icon: <PhotoIcon />, view: { kind: "similarity_review" } as const },
    { id: "unsorted", label: "미분류", count: unsortedCount ?? 0, icon: <InboxIcon />, view: { kind: "unsorted" } as const },
  ].filter((queue) => queue.count > 0);

  return <RadixDialog.Root modal={false} open={open} onOpenChange={setOpen}>
    <RadixDialog.Trigger asChild>
      <button type="button" className="status-center__trigger" data-state-tone={state} aria-label={label} aria-description={description}>
        {state === "active" ? <span className="status-center__spinner" aria-hidden="true" /> : <ActivityIcon aria-hidden="true" />}
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
          {cloud && <SyncBlock cloud={cloud} onOpenSettings={() => go({ kind: "settings", section: "cloud" })} />}
          <StatusBlock title="작업">
            <div className="status-center__list">
              {workCount === 0
                ? <p className="status-center__empty">진행 중인 작업이 없습니다.</p>
                : <>
                  <WorkTray works={works} retryFailed={retryWork} dismissWork={dismissWork}
                    openReview={() => go({ kind: "similarity_review" })} openExisting={(assetId) => { setOpen(false); openExisting(assetId); }} />
                  <PublicationStatus />
                  <VaultImportStatus />
                  <VaultExportStatus />
                  <CharacterAutomationStatus state={characterAutomation} />
                  <StatusBar status={browserStatus} progress={libraryProgress} dropEnabled={dropEnabled} similarityIndex={similarityIndex} />
                </>}
            </div>
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
    <h3 className="status-center__heading">{title}</h3>
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
  const [tone, text] = progress.replicationEnabled === false ? ["off", "클라우드 동기화 꺼짐"]
    : progress.controlState === "paused" ? ["off", remaining > 0 ? `동기화 일시 정지 · ${remaining.toLocaleString()}개 대기` : "동기화 일시 정지"]
      : remaining > 0 ? ["active", `동기화 중 · ${remaining.toLocaleString()}개 남음`]
        : ["ok", "동기화됨"];
  return <StatusBlock title="동기화">
    <div className="status-center__sync" data-tone={tone} role="status">
      <span className="status-center__dot" aria-hidden="true" />
      <span>{text}</span>
    </div>
  </StatusBlock>;
}

function LightweightBlock() {
  if (!nativeWorkload()) return null;
  return <StatusBlock title="이 PC"><LightweightModeToggle /></StatusBlock>;
}
