import { BookOpenIcon, CalendarIcon, InboxIcon, Cog6ToothIcon, EllipsisHorizontalIcon, MagnifyingGlassIcon, NoteIcon, PhotoIcon, PlusIcon, RectangleStackIcon, TrashIcon } from "../shared/ui/ArchiveIcons";
import { useRef, type CSSProperties, type ReactNode } from "react";
import lakomicsMark from "../brand/lakomics-mark.svg?no-inline";
import type { AssetView, CollectionType } from "../library/types";
import { Menu } from "../shared/ui/Menu";
import { ChromeSettingsDock, ChromeTarget } from "./WorkspaceChrome";
import { useWorkspaceChrome } from "./WorkspaceChromeContext";
import { clampSidebarWidth, MIN_SIDEBAR_WIDTH, MAX_SIDEBAR_WIDTH } from "./sidebarWidth";

export function workspaceArea(view: AssetView): "assets" | "collections" | "manga" | "notes" | "manage" {
  if (view.kind === "notes") return "notes";
  if (view.kind === "collections" || view.kind === "collection") return "collections";
  if (view.kind === "manga") return "manga";
  if (view.kind === "settings" || view.kind === "trash" || view.kind === "similarity_review" || view.kind === "statistics") return "manage";
  return "assets";
}
type Props = {
  view: AssetView;
  collectionType: CollectionType;
  width: number;
  onWidthChange: (width: number) => void;
  onNavigate: (view: AssetView) => void;
  assetNavigation: ReactNode;
  reviewCount: number;
  trashCount: number;
  cloudProblemCount?: number;
  onImportFiles?: () => void;
};

export function WorkspaceNavigation({ view, collectionType, width, onWidthChange, onNavigate, assetNavigation, reviewCount, trashCount, cloudProblemCount = 0, onImportFiles }: Props) {
  const chrome = useWorkspaceChrome();
  const area = workspaceArea(view);
  const history = useRef<Partial<Record<ReturnType<typeof workspaceArea>, AssetView>>>({});
  const collectionList = useRef<Extract<AssetView, { kind: "collections" }> | null>(null);
  if (view.kind === "collections") collectionList.current = view;
  const quickAssetView = view.kind === "revisit" || view.kind === "creator" || view.kind === "unsorted";
  if (!quickAssetView) history.current[area] = view;
  const resize = useRef<{ id: number; x: number; width: number } | null>(null);
  const areaName = { assets: "에셋", collections: "컬렉션", manga: "망가", notes:"메모", manage: "라이브러리 관리" }[area];
  const enterArea = (next: "assets" | "collections" | "manga") => {
    if (next === "collections" && view.kind === "collection") {
      onNavigate(collectionList.current ?? { kind: "collections", typeFilter: collectionType, showcase: false });
      return;
    }
    if (next === area && !quickAssetView) return;
    onNavigate(history.current[next] ?? (next === "collections" ? { kind: "collections", typeFilter: collectionType, showcase: false } : next === "manga" ? { kind: "manga" } : { kind: "classification", classificationId: null }));
  };
  const management = [
    { id: "statistics", label: "통계", icon: <CalendarIcon />, onSelect: () => onNavigate({ kind: "statistics" }) },
    { id: "review", label: `유사 검토 (${reviewCount})`, icon: <PhotoIcon />, onSelect: () => onNavigate({ kind: "similarity_review" }) },
    { id: "trash", label: `휴지통 (${trashCount})`, icon: <TrashIcon />, onSelect: () => onNavigate({ kind: "trash" }) },
    { id: "settings", label: "설정", icon: <Cog6ToothIcon />, onSelect: () => onNavigate({ kind: "settings" }) },
  ];
  return <div className="workspace-navigation">
    <nav className="workspace-rail" aria-label="주요 영역">
      <span className="workspace-mark"><img src={lakomicsMark} alt="Lakomics" width="32" height="32" /></span>
      {(["assets", "collections", "manga"] as const).map((key) => {
        const Icon = key === "assets" ? RectangleStackIcon : key === "collections" ? BookOpenIcon : PhotoIcon;
        const label = { assets: "에셋", collections: "컬렉션", manga: "망가" }[key];
        return <button key={key} type="button" className="workspace-rail__item" aria-current={area === key && !quickAssetView ? "page" : undefined} onClick={() => enterArea(key)}><Icon aria-hidden="true" /><span>{label}</span></button>;
      })}
      <button type="button" className="workspace-rail__item" aria-current={view.kind === "revisit" || view.kind === "creator" ? "page" : undefined} onClick={() => onNavigate({ kind: "revisit" })}><CalendarIcon aria-hidden="true" /><span>다시보기</span></button>
      <button type="button" className="workspace-rail__item" aria-current={view.kind === "notes" ? "page" : undefined} onClick={() => onNavigate({kind:"notes"})}><NoteIcon aria-hidden="true"/><span>메모</span></button>
      <div className="workspace-rail__tail">
        {cloudProblemCount > 0 && <button type="button" className="workspace-rail__item" onClick={() => onNavigate({ kind: "settings", section: "cloud" })} aria-label={`동기화 문제 ${cloudProblemCount}개`}><span aria-hidden="true">!</span><span>동기화 문제 {cloudProblemCount}</span></button>}
        <button type="button" className="workspace-rail__item" aria-current={view.kind === "unsorted" ? "page" : undefined} onClick={() => onNavigate({ kind: "unsorted" })}><InboxIcon aria-hidden="true" /><span>미분류</span></button>
        <button type="button" className="workspace-rail__item" aria-label={`휴지통 ${trashCount}개`} aria-current={view.kind === "trash" ? "page" : undefined} onClick={() => onNavigate({ kind: "trash" })}><TrashIcon aria-hidden="true" /><span>휴지통</span></button>
        <Menu label="라이브러리 관리" trigger={<><EllipsisHorizontalIcon aria-hidden="true" /><span>관리</span>{reviewCount > 0 && <span className="workspace-rail__review-alert" role="img" aria-label={`유사 검토 ${reviewCount}개 대기`} title={`유사 검토 ${reviewCount}개 대기`}>!</span>}</>} items={management} />
      </div>
    </nav>
    <aside className="workspace-index" style={{ "--workspace-index-width": `${width}px` } as CSSProperties} aria-label="탐색 인덱스">
      <header className="workspace-index__head" aria-label={areaName} data-tauri-drag-region="deep">
        <div className="workspace-index__head-actions">
          {view.kind === "settings" && <span className="workspace-section-label">설정</span>}
          <ChromeTarget name="search" />
          {view.kind !== "settings" && !chrome?.meta?.search && <span title="이 화면에는 별도의 텍스트 검색이 없습니다"><button type="button" className="ui-button ui-button--icon ui-button--ghost ui-button--unsupported" aria-disabled="true" aria-label="검색 미지원" onClick={(event) => event.preventDefault()}><MagnifyingGlassIcon aria-hidden="true" /></button></span>}
          <ChromeTarget name="actions" />
          {area === "assets" && !chrome?.meta?.actions && onImportFiles && <button type="button" className="ui-button ui-button--icon ui-button--ghost" aria-label="파일 가져오기" data-tooltip="선택한 파일을 라이브러리로 가져오기" onClick={onImportFiles}><PlusIcon aria-hidden="true" /></button>}
        </div>
      </header>
      <div className="workspace-index__scroll">
        <div hidden={area !== "assets"} className="workspace-index__assets">{assetNavigation}</div>
        <ChromeTarget name="navigation" className="workspace-index__view-navigation" />
        {view.kind === "collections" && !chrome?.meta?.navigation && <div className="workspace-index__fallback"><span className="workspace-section-label">작품 유형</span>{(["game", "manga", "movie", "av"] as const).map((type) => <button key={type} type="button" className="workspace-index-link" onClick={() => onNavigate({ kind: "collections", typeFilter: type, showcase: false })}>{({ game: "게임", manga: "만화", movie: "영화", av: "AV" })[type]}</button>)}</div>}
        {area === "manage" && view.kind !== "settings" && <div className="workspace-index__fallback">{management.map((item) => <button key={item.id} type="button" className="workspace-index-link" aria-current={(item.id === "review" ? view.kind === "similarity_review" : view.kind === item.id) ? "page" : undefined} onClick={item.onSelect}>{item.icon}{item.label}</button>)}</div>}
        {view.kind === "collection" && <ChromeTarget name="details" className="collection-detail-sidebar" />}
      </div>
      <ChromeSettingsDock />
      <div className="workspace-index__resize" role="separator" aria-label="사이드바 너비 조절" aria-orientation="vertical"
        tabIndex={0} aria-valuemin={MIN_SIDEBAR_WIDTH} aria-valuemax={MAX_SIDEBAR_WIDTH} aria-valuenow={width}
        onPointerDown={(event) => { if (event.button !== 0) return; event.preventDefault(); resize.current = { id: event.pointerId, x: event.clientX, width }; event.currentTarget.setPointerCapture(event.pointerId); }}
        onPointerMove={(event) => { const start = resize.current; if (start?.id === event.pointerId) onWidthChange(clampSidebarWidth(start.width + event.clientX - start.x)); }}
        onPointerUp={(event) => { if (resize.current?.id !== event.pointerId) return; resize.current = null; event.currentTarget.releasePointerCapture(event.pointerId); }}
        onPointerCancel={() => { resize.current = null; }}
        onKeyDown={(event) => {
          if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
          event.preventDefault();
          onWidthChange(event.key === "Home" ? MIN_SIDEBAR_WIDTH : event.key === "End" ? MAX_SIDEBAR_WIDTH : clampSidebarWidth(width + (event.key === "ArrowRight" ? 8 : -8)));
        }}
      />
    </aside>
  </div>;
}
