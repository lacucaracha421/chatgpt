import { BookmarkIcon, BookOpenIcon, ExchangeIcon, MagnifyingGlassIcon, NoteIcon, PhotoIcon, PlusIcon, RectangleStackIcon } from "../shared/ui/ArchiveIcons";
import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import lakomicsMark from "../brand/lakomics-mark.svg?no-inline";
import type { AssetView, CollectionType } from "../library/types";
import { useVaultExportJob, vaultExportProgressText } from "../external-vault/vaultExportJob";
import { useVaultImportJob, vaultImportProgressText } from "../external-vault/vaultImportJob";
import { CommandPalette } from "./CommandPalette";
import { MoreEntryList, MorePanel } from "./MorePanel";
import { placeEntries, useNavigationEntries, type PlaceSources } from "./navigationEntries";
import { modalDialogOpen } from "./modalDialog";
import { ChromeSettingsDock, ChromeTarget } from "./WorkspaceChrome";
import { useWorkspaceChrome } from "./WorkspaceChromeContext";
import { clampSidebarWidth, MIN_SIDEBAR_WIDTH, MAX_SIDEBAR_WIDTH } from "./sidebarWidth";

export function workspaceArea(view: AssetView): "assets" | "collections" | "manga" | "notes" | "exchange" | "private_vault" | "manage" {
  if (view.kind === "notes") return "notes";
  if (view.kind === "exchange") return "exchange";
  if (view.kind === "private_vault") return "private_vault";
  if (view.kind === "collections" || view.kind === "collection") return "collections";
  if (view.kind === "manga") return "manga";
  if (view.kind === "settings" || view.kind === "trash" || view.kind === "similarity_review" || view.kind === "statistics") return "manage";
  return "assets";
}
type RailArea = "assets" | "collections" | "manga" | "notes" | "exchange" | "private_vault";
const RAIL_AREAS: { key: RailArea; label: string; Icon: typeof NoteIcon }[] = [
  { key: "assets", label: "에셋", Icon: RectangleStackIcon },
  { key: "collections", label: "컬렉션", Icon: BookOpenIcon },
  { key: "manga", label: "망가", Icon: PhotoIcon },
  { key: "notes", label: "메모", Icon: NoteIcon },
  { key: "exchange", label: "전송", Icon: ExchangeIcon },
];

type Props = {
  view: AssetView;
  collectionType: CollectionType;
  width: number;
  onWidthChange: (width: number) => void;
  onNavigate: (view: AssetView) => void;
  assetNavigation: ReactNode;
  reviewCount: number;
  trashCount: number;
  /** Null until read; read again whenever 더보기 or the 찾기 palette opens. */
  unsortedCount?: number | null;
  onQueuesRequested?: () => void;
  privateVaultAvailable?: boolean;
  onImportFiles?: () => void;
  /** Folders, albums and characters the 찾기 palette matches by name. */
  places?: PlaceSources;
};

function isEditing(target: EventTarget | null) {
  return target instanceof HTMLElement
    && (target.isContentEditable || target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement);
}

export function WorkspaceNavigation({ view, collectionType, width, onWidthChange, onNavigate, assetNavigation, reviewCount, trashCount, unsortedCount = null, onQueuesRequested, privateVaultAvailable = false, onImportFiles, places }: Props) {
  const chrome = useWorkspaceChrome();
  const vaultImport = useVaultImportJob().job;
  const vaultExport = useVaultExportJob();
  const vaultImportText = vaultImport?.running ? vaultImportProgressText(vaultImport)
    : vaultExport?.running ? vaultExportProgressText(vaultExport) : undefined;
  const area = workspaceArea(view);
  const history = useRef<Partial<Record<ReturnType<typeof workspaceArea>, AssetView>>>({});
  const collectionList = useRef<Extract<AssetView, { kind: "collections" }> | null>(null);
  if (view.kind === "collections") collectionList.current = view;
  const quickAssetView = view.kind === "revisit" || view.kind === "creators" || view.kind === "creator" || view.kind === "calendar" || view.kind === "revisited-bundle" || view.kind === "unsorted";
  if (!quickAssetView) history.current[area] = view;
  const resize = useRef<{ id: number; x: number; width: number } | null>(null);
  const areaName = { assets: "에셋", collections: "컬렉션", manga: "망가", notes:"메모", exchange: "전송", private_vault: "비밀", manage: "더보기" }[area];
  const areaTitle = view.kind === "settings" ? "설정" : area === "manage" ? "더보기" : areaName;
  const enterArea = (next: RailArea) => {
    if (next === "collections" && view.kind === "collection") {
      onNavigate(collectionList.current ?? { kind: "collections", typeFilter: collectionType, showcase: false });
      return;
    }
    if (next === area && !quickAssetView) return;
    onNavigate(history.current[next] ?? (next === "collections" ? { kind: "collections", typeFilter: collectionType, showcase: false } : next === "manga" ? { kind: "manga" } : next === "notes" ? { kind: "notes" } : next === "exchange" ? { kind: "exchange" } : next === "private_vault" ? { kind: "private_vault" } : { kind: "classification", classificationId: null }));
  };
  const entries = useNavigationEntries({ view, onNavigate, reviewCount, unsortedCount, trashCount, privateVaultAvailable, privateVaultActivity: vaultImportText, onImportFiles });
  // 메모, 전송 and 비밀 are on the rail; the palette still finds them by name.
  const moreEntries = entries.filter((entry) => entry.id !== "notes" && entry.id !== "exchange" && entry.id !== "private_vault");
  const exchangeCount = entries.find((entry) => entry.id === "exchange")?.count ?? 0;
  // 비밀 joins the rail only while its USB is attached.
  const railAreas = privateVaultAvailable ? [...RAIL_AREAS, { key: "private_vault" as const, label: "비밀", Icon: BookmarkIcon }] : RAIL_AREAS;
  const searchInfo = chrome?.meta?.search ?? null;
  const paletteSearch = searchInfo && chrome ? { info: searchInfo, apply: chrome.applySearch, open: chrome.openSearch } : null;
  const [paletteOpen, setPaletteOpen] = useState(false);
  const paletteButton = useRef<HTMLButtonElement>(null);
  const queuesRequested = useRef(onQueuesRequested);
  queuesRequested.current = onQueuesRequested;
  const openPalette = () => { setPaletteOpen(true); queuesRequested.current?.(); };
  useEffect(() => {
    const shortcut = (event: KeyboardEvent) => {
      const key = event.key.toLowerCase();
      if ((key !== "k" && key !== "f") || !(event.ctrlKey || event.metaKey) || event.altKey || event.shiftKey) return;
      // Not over another dialog such as the asset viewer. Ctrl+K also waits while typing; Ctrl+F is the find key and works from a field.
      if (event.defaultPrevented || modalDialogOpen() || (key === "k" && isEditing(event.target))) return;
      event.preventDefault();
      setPaletteOpen(true);
      queuesRequested.current?.();
    };
    window.addEventListener("keydown", shortcut);
    return () => window.removeEventListener("keydown", shortcut);
  }, []);
  return <div className="workspace-navigation">
    <nav className="workspace-rail" aria-label="주요 영역">
      <span className="workspace-mark"><img src={lakomicsMark} alt="Lakomics" width="32" height="32" /></span>
      {railAreas.map(({ key, label, Icon }) => {
        const count = key === "exchange" ? exchangeCount : 0;
        const activity = key === "private_vault" ? vaultImportText : undefined;
        return <button key={key} type="button" className="workspace-rail__item" aria-current={area === key ? "page" : undefined}
          aria-description={count > 0 ? `받은 파일 ${count}개` : activity} onClick={() => enterArea(key)}>
          <span className="workspace-rail__icon"><Icon aria-hidden="true" />{count > 0 && <span className="workspace-rail__count" aria-hidden="true">{count > 99 ? "99+" : count}</span>}</span>
          <span>{label}</span>{activity && <span className="workspace-rail__activity" aria-hidden="true" />}</button>;
      })}
      <div className="workspace-rail__tail">
        <button ref={paletteButton} type="button" className="workspace-rail__item" aria-label="찾기" aria-keyshortcuts="Control+K Control+F"
          aria-description={searchInfo ? `${searchInfo.scope}에서 검색하거나 이름으로 이동 (Ctrl+K)` : "이름으로 이동하거나 명령 실행 (Ctrl+K)"} onClick={openPalette}>
          <MagnifyingGlassIcon aria-hidden="true" /><span>찾기</span><kbd className="workspace-rail__hint" aria-hidden="true">Ctrl K</kbd>
        </button>
        <MorePanel entries={moreEntries} current={area === "manage"} onOpenChange={(open) => { if (open) queuesRequested.current?.(); }} />
      </div>
    </nav>
    <aside className="workspace-index" style={{ "--workspace-index-width": `${width}px` } as CSSProperties} aria-label="탐색 인덱스">
      <header className="workspace-index__head" aria-label={areaName} data-tauri-drag-region="deep">
        <span className="workspace-index__title" aria-hidden="true">{areaTitle}</span>
        <div className="workspace-index__head-actions">
          <ChromeTarget name="search" />
          <ChromeTarget name="actions" />
          {area === "assets" && !chrome?.meta?.actions && onImportFiles && <button type="button" className="ui-button ui-button--icon ui-button--ghost" aria-label="파일 가져오기" aria-description="선택한 파일을 라이브러리로 가져오기" onClick={onImportFiles}><PlusIcon aria-hidden="true" /></button>}
        </div>
      </header>
      <div className="workspace-index__scroll">
        <div hidden={area !== "assets"} className="workspace-index__assets">{assetNavigation}</div>
        <ChromeTarget name="navigation" className="workspace-index__view-navigation" />
        {view.kind === "collections" && !chrome?.meta?.navigation && <div className="workspace-index__fallback"><span className="workspace-section-label">작품 유형</span>{(["game", "manga", "movie", "av"] as const).map((type) => <button key={type} type="button" className="workspace-index-link" onClick={() => onNavigate({ kind: "collections", typeFilter: type, showcase: false })}>{({ game: "게임", manga: "만화", movie: "영화", av: "AV" })[type]}</button>)}</div>}
        {area === "manage" && view.kind !== "settings" && <div className="workspace-index__fallback"><MoreEntryList entries={moreEntries.filter((entry) => entry.group === "queue" || entry.group === "go")} heading="더보기" /></div>}
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
    <CommandPalette open={paletteOpen} onClose={() => setPaletteOpen(false)} entries={entries} search={paletteSearch} findPlaces={(query) => placeEntries(places, query, view, onNavigate)} fallbackFocus={() => paletteButton.current} />
  </div>;
}
