import { FolderIcon, MagnifyingGlassIcon, PlusIcon, RectangleStackIcon } from "@heroicons/react/24/outline";
import { AREA_ICONS } from "../shared/ui/areaIcons";
import type { IconGlyph } from "../shared/ui/IconButton";
import { SidebarCloseIcon } from "../shared/ui/SidebarIcons";
import { Button } from "../shared/ui/Button";
import { CountBadge } from "../shared/ui/Badge";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { EASE_STANDARD, reducedMotion } from "../shared/motion/curves";
import lakomicsMark from "../brand/lakomics-mark.svg?no-inline";
import type { AssetView, CollectionType, CollectionSummary } from "../library/types";
import { useOptionalLibrary } from "../library/LibraryContext";
import { useVaultExportJob, vaultExportProgressText } from "../external-vault/vaultExportJob";
import { useVaultImportJob, vaultImportProgressText } from "../external-vault/vaultImportJob";
import { ArtistIndex, isArtistView } from "../artists/ArtistIndex";
import { useArtistOverview } from "../artists/artistStore";
import { useFindData } from "./findData";
import { rememberRecent } from "./findModel";
import { CommandPalette } from "./CommandPalette";
import { descriptionSearchSource } from "../assets/descriptionSearch";
import { useAutoTagPaletteSearch } from "../autotags/autoTagPalette";
import { MoreEntryList, MorePanel } from "./MorePanel";
import { placeEntries, useNavigationEntries, type PlaceSources } from "./navigationEntries";
import { modalDialogOpen } from "./modalDialog";
import { ChromeSettingsDock, ChromeTarget } from "./WorkspaceChrome";
import { useWorkspaceChrome, type ChromeMeta } from "./WorkspaceChromeContext";
import { clampSidebarWidth, MIN_SIDEBAR_WIDTH, MAX_SIDEBAR_WIDTH } from "./sidebarWidth";

export function workspaceArea(view: AssetView): "home" | "assets" | "collections" | "manga" | "notes" | "exchange" | "private_vault" | "manage" {
  if (view.kind === "home") return "home";
  if (view.kind === "notes") return "notes";
  if (view.kind === "exchange") return "exchange";
  if (view.kind === "private_vault") return "private_vault";
  if (view.kind === "collections" || view.kind === "collection") return "collections";
  if (view.kind === "manga") return "manga";
  if (view.kind === "settings" || view.kind === "trash" || view.kind === "similarity_review" || view.kind === "statistics") return "manage";
  return "assets";
}

/** Whether the painted area reserves an index beside the rail. */
export function hasWorkspaceIndex(view: AssetView, collections: CollectionSummary[], meta: ChromeMeta | null) {
  const area = workspaceArea(view);
  const emptyIndex = (area === "home" || (area === "notes" && meta != null))
    && !meta?.navigation && !meta?.actions && meta?.search?.kind !== "surface";
  // Full-screen work viewers must not reserve an empty column while artwork prepares.
  const workViewer = view.kind === "collection" && ["game", "movie", "av", "manga"].includes(collections.find(item => item.id === view.collectionId)?.type ?? "");
  return view.kind !== "collections" && !workViewer && !emptyIndex;
}
type RailArea = "home" | "assets" | "collections" | "manga" | "notes" | "exchange" | "private_vault";
const RAIL_AREAS: { key: RailArea; label: string; Icon: IconGlyph }[] = [
  { key: "home", label: "홈", Icon: AREA_ICONS.home },
  { key: "assets", label: "에셋", Icon: AREA_ICONS.assets },
  { key: "collections", label: "컬렉션", Icon: AREA_ICONS.collections },
  { key: "manga", label: "망가", Icon: AREA_ICONS.manga },
  { key: "notes", label: "메모", Icon: AREA_ICONS.notes },
  { key: "exchange", label: "전송", Icon: AREA_ICONS.exchange },
];

type Props = {
  view: AssetView;
  /** The rail responds to requests while the index keeps the painted view until ready. */
  requestedView?: AssetView;
  settling?: boolean;
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
  collections?: CollectionSummary[];
};

export function WorkspaceNavigation({ view, requestedView = view, settling = false, collectionType, width, onWidthChange, onNavigate, assetNavigation, reviewCount, trashCount, unsortedCount = null, onQueuesRequested, privateVaultAvailable = false, onImportFiles, places, collections = [] }: Props) {
  const chrome = useWorkspaceChrome();
  const vaultImport = useVaultImportJob().job;
  const vaultExport = useVaultExportJob();
  const vaultImportText = vaultImport?.running ? vaultImportProgressText(vaultImport)
    : vaultExport?.running ? vaultExportProgressText(vaultExport) : undefined;
  const area = workspaceArea(view);
  const requestedArea = workspaceArea(requestedView);
  const history = useRef<Partial<Record<ReturnType<typeof workspaceArea>, AssetView>>>({});
  const collectionList = useRef<Extract<AssetView, { kind: "collections" }> | null>(null);
  if (requestedView.kind === "collections") collectionList.current = requestedView;
  const quickAssetView = isArtistView(requestedView) || requestedView.kind === "unsorted";
  // A note opened from Home is not where the 메모 rail entry returns to.
  if (!quickAssetView) history.current[requestedArea] = requestedView.kind === "notes" && requestedView.noteId ? { kind: "notes" } : requestedView;
  const resize = useRef<{ id: number; x: number; width: number } | null>(null);
  const areaName = { home: "홈", assets: "에셋", collections: "컬렉션", manga: "망가", notes:"메모", exchange: "전송", private_vault: "비밀", manage: "더보기" }[area];
  const artistView = isArtistView(view);
  const areaTitle = view.kind === "settings" ? "설정" : area === "manage" ? "더보기" : areaName;
  const canToggleIndex = area === "manga" && chrome != null;
  const hideIndex = !hasWorkspaceIndex(view, collections, chrome?.meta ?? null);
  // Hidden by the user, the index stays mounted: its search dialog and content survive and come back without reloading.
  const indexHiddenByUser = canToggleIndex && chrome.indexHidden[area] === true;
  const indexClosed = hideIndex || indexHiddenByUser;
  const indexClip = useRef<HTMLDivElement>(null);
  const previousClosed = useRef(indexClosed);
  const indexEntrance = useRef(false);
  useLayoutEffect(() => {
    if (previousClosed.current && !indexClosed) indexEntrance.current = true;
    previousClosed.current = indexClosed;
    if (indexClosed) indexEntrance.current = false;
    const clip = indexClip.current;
    if (!clip || !indexEntrance.current || settling) return;
    indexEntrance.current = false;
    if (document.documentElement.hasAttribute("data-area-view-transition")) return;
    if (typeof clip.animate !== "function") return;
    clip.style.willChange = "opacity";
    const duration = reducedMotion() ? 120 : 150;
    const easing = getComputedStyle(clip).getPropertyValue("--ease-out").trim() || EASE_STANDARD;
    const animation = clip.animate([{opacity: 0}, {opacity: 1}], {duration, easing});
    const finish = () => { clip.style.willChange = ""; };
    animation.onfinish = finish;
    const timer = window.setTimeout(finish, duration);
    return () => { window.clearTimeout(timer); animation.onfinish = null; animation.cancel(); finish(); };
  }, [indexClosed, settling]);
  const indexContent = useRef<ReactNode>(null);
  const assetTotalCount = useAssetTotalCount(area === "assets");
  const artistOverview = useArtistOverview();
  const enterArea = (next: RailArea) => {
    if (next === "collections" && requestedView.kind === "collection") {
      onNavigate(collectionList.current ?? { kind: "collections", typeFilter: collectionType, showcase: false });
      return;
    }
    if (next === requestedArea && !quickAssetView) return;
    onNavigate(history.current[next] ?? (next === "collections" ? { kind: "collections", typeFilter: collectionType, showcase: false } : next === "manga" ? { kind: "manga" } : next === "home" ? { kind: "home" } : next === "notes" ? { kind: "notes" } : next === "exchange" ? { kind: "exchange" } : next === "private_vault" ? { kind: "private_vault" } : { kind: "classification", classificationId: null }));
  };
  const entries = useNavigationEntries({ view, onNavigate, reviewCount, unsortedCount, trashCount, privateVaultAvailable, privateVaultActivity: vaultImportText, onImportFiles });
  // 메모, 전송 and 비밀 are on the rail; the palette still finds them by name.
  const moreEntries = entries.filter((entry) => entry.id !== "notes" && entry.id !== "exchange" && entry.id !== "private_vault");
  const exchangeCount = entries.find((entry) => entry.id === "exchange")?.count ?? 0;
  // 비밀 joins the rail only while its USB is attached.
  const railAreas = privateVaultAvailable ? [...RAIL_AREAS, { key: "private_vault" as const, label: "비밀", Icon: AREA_ICONS.private_vault }] : RAIL_AREAS;
  const searchInfo = chrome?.meta?.search ?? null;
  const paletteSearch = searchInfo && chrome ? { info: searchInfo, apply: chrome.applySearch, open: chrome.openSearch } : null;
  const [paletteOpen, setPaletteOpen] = useState(false);
  const find = useFindData(paletteOpen, collections, onNavigate);
  useEffect(() => {
    const id = view.kind === "collection" ? `work-${view.collectionId}`
      : view.kind === "creator" ? `artist-${view.creatorKey}`
      : view.kind === "notes" && view.noteId ? `note-${view.noteId}`
      : view.kind === "classification" && view.classificationId ? (view.characterId ? `place-character-${view.characterId}` : `place-folder-${view.classificationId}`)
      : view.kind === "album" ? `place-album-${view.albumId}` : null;
    if (id) rememberRecent(find.recentKey, id);
  }, [view, find.recentKey]);
  const paletteEntries = [...find.entries,
    { id: "home", group: "go" as const, label: "홈", icon: <AREA_ICONS.home />, run: () => onNavigate({ kind: "home" }) },
    { id: "assets", group: "go" as const, label: "에셋", icon: <AREA_ICONS.assets />, run: () => onNavigate({ kind: "classification", classificationId: null }) },
    { id: "collections", group: "go" as const, label: "컬렉션", icon: <AREA_ICONS.collections />, run: () => onNavigate({ kind: "collections", typeFilter: collectionType, showcase: false }) },
    { id: "manga", group: "go" as const, label: "망가", icon: <AREA_ICONS.manga />, run: () => onNavigate({ kind: "manga" }) },
    ...entries];
  const findTags = useAutoTagPaletteSearch(paletteOpen, view, onNavigate);
  const libraryGateway = useOptionalLibrary()?.gateway;
  const descriptionSource = useMemo(() => descriptionSearchSource(libraryGateway), [libraryGateway]);
  const descriptionSearch = descriptionSource ? { source: descriptionSource, open: (query: string) => onNavigate({ kind: "description_search", query }) } : null;
  const paletteButton = useRef<HTMLButtonElement>(null);
  const queuesRequested = useRef(onQueuesRequested);
  queuesRequested.current = onQueuesRequested;
  const openPalette = useCallback(() => { setPaletteOpen(true); queuesRequested.current?.(); }, []);
  const setFindAction = chrome?.setFindAction;
  useEffect(() => { setFindAction?.(openPalette); return () => setFindAction?.(null); }, [setFindAction, openPalette]);
  useEffect(() => {
    const shortcut = (event: KeyboardEvent) => {
      // Ctrl+Q (user, 2026-10-05; replaced Ctrl+K / Ctrl+F). It has no text-editing meaning, so it also works from a field.
      // Match the physical key too: with the Korean IME on, the Q key reports "ㅂ".
      const isQ = event.code === "KeyQ" || event.key.toLowerCase() === "q";
      if (!isQ || !event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return;
      // Not over another dialog such as the asset viewer.
      if (event.defaultPrevented || modalDialogOpen()) return;
      event.preventDefault();
      setPaletteOpen(true);
      queuesRequested.current?.();
    };
    window.addEventListener("keydown", shortcut);
    return () => window.removeEventListener("keydown", shortcut);
  }, []);
  if (!hideIndex) indexContent.current = <aside className="workspace-index" inert={chrome?.pending || indexHiddenByUser || undefined} style={{ "--workspace-index-width": `${width}px` } as CSSProperties} aria-label="탐색 인덱스">
      <header className="workspace-index__head" aria-label={areaName} data-tauri-drag-region="deep">
        <span className="workspace-index__title" aria-hidden="true">{areaTitle}</span>
        <div className="workspace-index__head-actions">
          {canToggleIndex && <Button type="button" size="icon" variant="ghost" aria-label="사이드바 숨기기" onClick={() => chrome.setIndexHidden(area, true)}><SidebarCloseIcon aria-hidden="true" /></Button>}
          <ChromeTarget name="search" />
          <ChromeTarget name="actions" />
          {area === "assets" && !chrome?.meta?.actions && onImportFiles && <button type="button" className="ui-button ui-button--icon ui-button--ghost" aria-label="파일 가져오기" aria-description="선택한 파일을 라이브러리로 가져오기" onClick={onImportFiles}><PlusIcon aria-hidden="true" /></button>}
        </div>
      </header>
      <div className="workspace-index__scroll">
        {area === "assets" && <AssetIndexTop view={view} onNavigate={onNavigate} totalCount={assetTotalCount} artistCount={artistOverview?.main ?? null} albumCount={places?.albums.length ?? null} />}
        <div hidden={area !== "assets" || artistView} className="workspace-index__assets">{assetNavigation}</div>
        {artistView && <ArtistIndex view={view} onNavigate={onNavigate} />}
        <ChromeTarget name="navigation" className="workspace-index__view-navigation" />
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
    </aside>;
  return <div className="workspace-navigation">
    <nav className="workspace-rail" aria-label="주요 영역">
      <span className="workspace-mark"><img src={lakomicsMark} alt="Lakomics" width="32" height="32" /></span>
      {railAreas.map(({ key, label, Icon }) => {
        const count = key === "exchange" ? exchangeCount : 0;
        const activity = key === "private_vault" ? vaultImportText : undefined;
        return <button key={key} type="button" className="workspace-rail__item" aria-current={requestedArea === key ? "page" : undefined}
          aria-description={count > 0 ? `받은 파일 ${count}개` : activity} onClick={() => enterArea(key)}>
          <span className="workspace-rail__icon"><Icon aria-hidden="true" />{count > 0 && <CountBadge variant="corner" className="workspace-rail__count" aria-hidden="true" value={count} max={99} />}</span>
          <span>{label}</span>{activity && <span className="workspace-rail__activity" aria-hidden="true" />}</button>;
      })}
      <div className="workspace-rail__tail">
        <button ref={paletteButton} type="button" className="workspace-rail__item" aria-label="찾기" aria-keyshortcuts="Control+Q"
          aria-description={searchInfo ? `${searchInfo.scope}에서 검색하거나 이름으로 이동 (Ctrl+Q)` : "이름으로 이동하거나 명령 실행 (Ctrl+Q)"} onClick={openPalette}>
          <MagnifyingGlassIcon aria-hidden="true" /><span>찾기</span><kbd className="workspace-rail__hint" aria-hidden="true">Ctrl Q</kbd>
        </button>
        <MorePanel entries={moreEntries} current={requestedArea === "manage"} onOpenChange={(open) => { if (open) queuesRequested.current?.(); }} />
      </div>
    </nav>
    <div className="workspace-index-slot" data-state={hideIndex || indexHiddenByUser ? "closed" : "open"} inert={hideIndex || indexHiddenByUser || chrome?.pending || undefined} aria-hidden={hideIndex || indexHiddenByUser || undefined} style={{ "--workspace-index-width": `${width}px` } as CSSProperties}>
      <div ref={indexClip} className="workspace-index-clip" hidden={indexClosed} style={{opacity: !indexClosed && settling && (previousClosed.current || indexEntrance.current) ? 0 : undefined}}>{indexContent.current}</div>
    </div>
    <CommandPalette open={paletteOpen} onClose={() => setPaletteOpen(false)} entries={paletteEntries} recentKey={find.recentKey} loading={find.loading} error={find.error} search={paletteSearch} descriptionSearch={descriptionSearch} findPlaces={(query) => placeEntries(places, query, view, onNavigate)} findTags={findTags} fallbackFocus={() => paletteButton.current} />
  </div>;
}

function AssetIndexTop({ view, onNavigate, totalCount, artistCount, albumCount }: {
  view: AssetView;
  onNavigate: (view: AssetView) => void;
  totalCount: number | null;
  artistCount: number | null;
  albumCount: number | null;
}) {
  return <nav className="classification-sidebar__pins asset-index__top" aria-label="에셋 보기">
    <AssetIndexTopRow icon={<FolderIcon aria-hidden="true" />} label="전체" count={totalCount} selected={view.kind === "classification" && view.classificationId === null} onClick={() => onNavigate({ kind: "classification", classificationId: null })} />
    <AssetIndexTopRow icon={<AREA_ICONS.artists aria-hidden="true" />} label="작가" count={artistCount} selected={view.kind === "artists" || view.kind === "creator"} onClick={() => onNavigate({ kind: "artists" })} />
    <AssetIndexTopRow icon={<RectangleStackIcon aria-hidden="true" />} label="앨범" count={albumCount} selected={view.kind === "albums" || view.kind === "album"} onClick={() => onNavigate({ kind: "albums" })} />
  </nav>;
}

function AssetIndexTopRow({ icon, label, count, selected, onClick }: {
  icon: ReactNode;
  label: string;
  count: number | null;
  selected: boolean;
  onClick: () => void;
}) {
  return <button type="button" className="classification-sidebar__quick-view" style={{ minHeight: "32px" }} aria-label={count === null ? label : `${label} ${formatIndexCount(count)}개`} aria-current={selected ? "page" : undefined} onClick={onClick}>
    <span className="classification-sidebar__quick-view-surface">
      {icon}
      <span className="classification-sidebar__quick-view-label">{label}</span>
      {count !== null && <span className="classification-sidebar__badge classification-sidebar__hover-count" style={{ color: "var(--color-faint)" }} aria-hidden="true">{formatIndexCount(count)}</span>}
    </span>
  </button>;
}

function useAssetTotalCount(enabled: boolean): number | null {
  const library = useOptionalLibrary();
  const gateway = library?.gateway;
  const [count, setCount] = useState<number | null>(null);
  useEffect(() => {
    if (!enabled || !gateway) {
      setCount(null);
      return;
    }
    let active = true;
    void gateway.listAssets({
      classificationId: null,
      albumId: null,
      collectionId: null,
      directOnly: false,
      unclassifiedOnly: false,
      mediaKind: null,
      aspectRatio: null,
      sort: "newest",
      randomPivot: null,
      after: null,
      limit: 1,
    }).then((page) => {
      if (active) setCount(page.totalCount ?? null);
    }).catch(() => {
      if (active) setCount(null);
    });
    return () => { active = false; };
  }, [enabled, gateway]);
  return count;
}

function formatIndexCount(count: number) {
  return count.toLocaleString("ko-KR");
}
