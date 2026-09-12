import { useState } from "react";
import type { AssetBrowserStatus } from "../assets/AssetBrowser";
import { CharacterAutomationStatus } from "../characters/CharacterAutomationStatus";
import type { useCharacterAutomation } from "../characters/useCharacterAutomation";
import type { DropProgress } from "../ingestion/useFileDrop";
import { usePublicationJobs } from "../library/publicationJobs";
import type { SimilarityIndexState } from "../similarity/useSimilarityIndex";
import { ActivityIcon, EllipsisHorizontalIcon } from "../shared/ui/ArchiveIcons";
import { AnchoredPanel } from "../shared/ui/AnchoredPanel";
import type { MenuItem } from "../shared/ui/Menu";
import { PublicationStatus } from "./PublicationStatus";
import { StatusBar } from "./StatusBar";
import "./WorkStatusCenter.css";

type WorkStatusCenterProps = {
  characterAutomation: ReturnType<typeof useCharacterAutomation>;
  progress: DropProgress | null;
  similarityIndex?: SimilarityIndexState;
  browserStatus?: AssetBrowserStatus;
  dropEnabled?: boolean;
  managementItems?: MenuItem[];
  reviewCount?: number;
};

export function WorkStatusCenter({
  characterAutomation,
  progress,
  similarityIndex,
  browserStatus = { loadedCount: 0, selectedAsset: null, loading: false },
  dropEnabled = false,
  managementItems,
  reviewCount = 0,
}: WorkStatusCenterProps) {
  const [open, setOpen] = useState(false);
  const publicationJobs = Object.values(usePublicationJobs()).filter(Boolean);
  const freshCharacterWork = Boolean(characterAutomation.activeWork && (characterAutomation.activeWork.freshRemaining > 0
    || (characterAutomation.activeWork.active && characterAutomation.activeWork.cause !== "reconsideration")));
  const characterFailures = (characterAutomation.historyRefreshes ?? []).filter(refresh => refresh.state === "failed").length;
  const characterVisible = Boolean(
    characterAutomation.persistentError || characterAutomation.historyRefreshActive || freshCharacterWork || characterFailures,
  );
  const libraryVisible = Boolean(progress || similarityIndex?.running || similarityIndex?.failed || similarityIndex?.message);
  const activeCount = publicationJobs.filter((job) => job.running).length
    + Number(characterAutomation.historyRefreshActive)
    + Number(freshCharacterWork)
    + Number(progress !== null)
    + Number(Boolean(similarityIndex?.running));
  const problemCount = publicationJobs.filter((job) => job.error).length
    + Number(Boolean(characterAutomation.persistentError))
    + characterFailures
    + Number(Boolean(similarityIndex?.failed || similarityIndex?.message));
  const visibleCount = publicationJobs.length + Number(characterVisible) + Number(libraryVisible);
  const state = problemCount > 0 ? "attention" : activeCount > 0 ? "active" : visibleCount > 0 ? "available" : "idle";
  const label = problemCount > 0
    ? `작업 센터 · 문제 ${problemCount}개`
    : activeCount > 0
      ? `작업 센터 · ${activeCount}개 진행 중`
      : visibleCount > 0 ? `작업 센터 · 확인할 항목 ${visibleCount}개` : "작업 센터";
  const description = [state !== "idle" ? label : null, reviewCount > 0 ? `유사 검토 ${reviewCount}개 대기` : null].filter(Boolean).join(" · ") || undefined;

  return <AnchoredPanel
    open={open}
    onOpenChange={setOpen}
    title={managementItems ? "라이브러리 관리" : "작업 센터"}
    description={managementItems ? undefined : "가져오기·분석·게시 작업을 확인합니다."}
    trigger={<button type="button" className="workspace-rail__item work-status-center__trigger" aria-label={managementItems ? "라이브러리 관리" : label}
      aria-description={managementItems ? description : undefined} aria-current={managementItems?.some((item) => item.selected) ? "page" : undefined} data-state={state}>
      {managementItems ? <EllipsisHorizontalIcon aria-hidden="true" /> : <ActivityIcon aria-hidden="true" />}
      <span>{managementItems ? "관리" : "작업"}</span>
      {(state !== "idle" || reviewCount > 0) && <span className="work-status-center__mark" aria-hidden="true">{problemCount > 0 ? "!" : activeCount || visibleCount || "!"}</span>}
    </button>}
  >
    {managementItems && <nav className="work-status-center__navigation" aria-label="관리 항목">
      {managementItems.map((item) => <button key={item.id} type="button" className="workspace-index-link"
        aria-current={item.selected ? "page" : undefined} onClick={() => { setOpen(false); item.onSelect(); }}>
        <span className="ui-menu__item-icon" aria-hidden="true">{item.icon}</span>{item.label}
      </button>)}
    </nav>}
    {managementItems && <h3 className="workspace-section-label">작업</h3>}
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
