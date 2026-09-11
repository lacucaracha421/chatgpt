import { useState } from "react";
import type { AssetBrowserStatus } from "../assets/AssetBrowser";
import { CharacterAutomationStatus } from "../characters/CharacterAutomationStatus";
import type { useCharacterAutomation } from "../characters/useCharacterAutomation";
import type { DropProgress } from "../ingestion/useFileDrop";
import { usePublicationJobs } from "../library/publicationJobs";
import type { SimilarityIndexState } from "../similarity/useSimilarityIndex";
import { ActivityIcon } from "../shared/ui/ArchiveIcons";
import { AnchoredPanel } from "../shared/ui/AnchoredPanel";
import { PublicationStatus } from "./PublicationStatus";
import { StatusBar } from "./StatusBar";
import "./WorkStatusCenter.css";

type WorkStatusCenterProps = {
  characterAutomation: ReturnType<typeof useCharacterAutomation>;
  progress: DropProgress | null;
  similarityIndex?: SimilarityIndexState;
  browserStatus?: AssetBrowserStatus;
  dropEnabled?: boolean;
};

export function WorkStatusCenter({
  characterAutomation,
  progress,
  similarityIndex,
  browserStatus = { loadedCount: 0, selectedAsset: null, loading: false },
  dropEnabled = false,
}: WorkStatusCenterProps) {
  const [open, setOpen] = useState(false);
  const publicationJobs = Object.values(usePublicationJobs()).filter(Boolean);
  const characterVisible = Boolean(characterAutomation.progress || characterAutomation.message || characterAutomation.paused || characterAutomation.queuePending > 0);
  const libraryVisible = Boolean(progress || similarityIndex?.running || similarityIndex?.failed || similarityIndex?.message);
  const activeCount = publicationJobs.filter((job) => job.running).length
    + Number(characterAutomation.progress !== null || characterAutomation.paused || characterAutomation.queuePending > 0)
    + Number(progress !== null)
    + Number(Boolean(similarityIndex?.running));
  const problemCount = publicationJobs.filter((job) => job.error).length
    + Number(Boolean(similarityIndex?.failed || similarityIndex?.message));
  const visibleCount = publicationJobs.length + Number(characterVisible) + Number(libraryVisible);
  const state = problemCount > 0 ? "attention" : activeCount > 0 ? "active" : visibleCount > 0 ? "available" : "idle";
  const label = problemCount > 0
    ? `작업 센터 · 문제 ${problemCount}개`
    : activeCount > 0
      ? `작업 센터 · ${activeCount}개 진행 중`
      : visibleCount > 0 ? `작업 센터 · 확인할 항목 ${visibleCount}개` : "작업 센터";

  return <AnchoredPanel
    open={open}
    onOpenChange={setOpen}
    title="작업 센터"
    description="가져오기·분석·게시 작업을 확인합니다."
    trigger={<button type="button" className="workspace-rail__item work-status-center__trigger" aria-label={label} data-state={state}>
      <ActivityIcon aria-hidden="true" />
      <span>작업</span>
      {state !== "idle" && <span className="work-status-center__mark" aria-hidden="true">{activeCount || problemCount || visibleCount}</span>}
    </button>}
  >
    <div className="work-status-center__list">
      {visibleCount === 0
        ? <p className="work-status-center__empty">진행 중인 작업이 없습니다.</p>
        : <>
          <PublicationStatus />
          <CharacterAutomationStatus state={characterAutomation} />
          <StatusBar status={browserStatus} progress={progress} dropEnabled={dropEnabled} similarityIndex={similarityIndex} />
        </>}
    </div>
  </AnchoredPanel>;
}
