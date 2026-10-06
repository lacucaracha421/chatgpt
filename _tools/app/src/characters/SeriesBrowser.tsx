import { pcPerfEnabled, pcFolderReady, pcFolderScope } from "../shared/pcPerfLog";
import { EmptyState } from "../shared/ui/EmptyState";
import { SeriesShelf } from "./SeriesShelf";
import { AssetImage } from "../privacy/AssetImage";
import { folderPreviewCache, rememberFolderPreview } from "../assets/folderPreviewCache";
import { AssetStableImage as StableImage } from "../privacy/AssetImage";
import { CharacterSuggestionTile, prefetchCharacterSuggestions, useCharacterSuggestions } from "./suggestions/CharacterSuggestions";
import { NO_SERIES_REVISIONS, readSeriesSidebarCounts, seriesDataScope, sidebarCountCache, type SeriesRevisions } from "./seriesMountCache";
import { invoke } from "@tauri-apps/api/core";
import { useCoalescedRefreshVersion } from "../shared/useCoalescedRefreshVersion";
import { cloneElement, useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type ComponentProps, type ReactElement, type ReactNode } from "react";
import { cancelSegmentSwap, swapSegment } from "../shared/motion/viewSwap";
import { preloadImages } from "../shared/motion/viewportImages";
import { READY_CAP_MS } from "../shared/motion/AreaSwitch";
import { ChevronRightIcon, EllipsisHorizontalIcon, FolderIcon, PencilIcon, UserGroupIcon, UserIcon, UserMinusIcon } from "@heroicons/react/24/outline";
import type { AlbumEntry, AssetAspectFilter, AssetMediaFilter, AssetSort, AssetSummary, AssetView, ClassificationEntry, LibraryGateway } from "../library/types";
import { useLibrary } from "../library/LibraryContext";
import { commandErrorMessage } from "../library/errorMessage";
import { AssetGallery, galleryFirstScreen, tileHasThumbnail, tileThumbnailUrl } from "../assets/AssetGallery";
import { AssetViewer, movableViewerFolders } from "../assets/AssetViewer";
import { AssetInspector } from "../assets/AssetInspector";
import { AssetInfoPanel } from "../assets/AssetInfoPanel";
import { AssetToolbar } from "../assets/AssetToolbar";
import { useInfoPanelPreference } from "../assets/useInfoPanelPreference";
import { CharacterAssignToast, markAssignedTiles, type CharacterAssignNoticeState } from "../assets/characterAssignNotice";
import { AssignArtistDialog } from "../artists/AssignArtistDialog";
import { visibleTileRect, type TileRect } from "../shared/viewer/useViewerMotion";
import { libraryContextItems } from "../assets/libraryContextItems";
import { thumbnailUrl } from "../assets/mediaUrl";
import { characterCardImage, folderCardImage, seriesShelfCardImages, shelfCardsInView } from "./shelfImages";
import { applySelectionGesture, emptySelection, focusAsset, moveSelectionFocus, selectAllLoaded } from "../assets/selection";
import { Button } from "../shared/ui/Button";
import { Menu } from "../shared/ui/Menu";
import { Dialog } from "../shared/ui/Dialog";
import { Toast } from "../shared/ui/Toast";
import { useAutoDismiss } from "../shared/ui/useAutoDismiss";
import { ContextMenu, type ContextMenuItem } from "../shared/ui/ContextMenu";
import { AnchoredPanel } from "../shared/ui/AnchoredPanel";
import { useBackHandler } from "../shared/navigation/BackNavigation";
import { collectPages, faultAssets, faultSelectionItem, useFaultGame, type FaultScope } from "../games/FaultGame";
import { CharacterRegistry, characterDraft, updateCharacterReferences, activeCharacterReferences, MAX_CHARACTER_REFERENCES, type CharacterEditorDraft } from "./CharacterRegistry";
import { CharacterConversion } from "./CharacterConversion";
import { CharacterTaggerTags } from "./CharacterTaggerTags";
import { needsReferenceConfirmation, useReferenceRegionInspection } from "./ReferenceRegionChoices";
import { folderExclusionItem } from "./folderExclusion";
import { CharacterGroups } from "./CharacterGroups";
import { FolderFilterControl } from "../assets/FolderShelf";
import { SelectionBar } from "../assets/SelectionBar";
import { CharacterAssignPicker } from "./CharacterAssignPicker";
import { ReferenceCandidateDialog } from "./ReferenceCandidateDialog";
import { ShadowReview } from "./ShadowReview";
import { shadowReviewApi, type ShadowReviewApi } from "./shadowReviewApi";
import { S36ScoringWarning, S36SeriesControl, readinessLabel, useS36CharacterExclusion, useS36Readiness, s36PublicationApi, type S36Readiness } from "./S36Publication";
import { characterApi, draftReferenceRegions, moveAssetsToCharacters, type CharacterApi, type CharacterTarget } from "./api";
import { prefetchRead, prefetchedRead, useFolderPrefetchIntent } from "../assets/folderPrefetch";
import { characterHubApi, type CharacterBrowsePage, type CharacterBrowseView, type CharacterGroup, type CharacterHubApi, type CharacterSeries, type SeriesGalleryFilter, type SeriesFolder } from "./hubApi";
import "./CharacterManagement.css";
import "./SeriesBrowser.css";

export type CharacterGalleryDrag = Pick<ComponentProps<typeof AssetGallery>, "onPointerDragStart" | "onPointerDragMove" | "onPointerDragEnd" | "onPointerDragCancel">;
type Props = {
  requestedAsset?: AssetSummary | null; onRequestedAssetHandled?: () => void;
  clearSelectionRequest?: number; galleryDrag?: CharacterGalleryDrag; albums?: AlbumEntry[];
  folderExclusions?: string[];
  series: CharacterSeries; targetId?: string; groupId?: string; targets: CharacterTarget[]; groups?: CharacterGroup[]; classifications: ClassificationEntry[];
  galleryLayout: "masonry" | "justified"; onGalleryLayoutChange: (layout: "masonry" | "justified") => void;
  /** The asset sort shared with plain folders; without `onSortChange` the gallery stays newest-first. */
  sort?: AssetSort; onSortChange?: (sort: AssetSort) => void;
  privacyMode: boolean; onPrivacyModeChange: (value: boolean) => void;
  metadataVisible: boolean; onMetadataVisibleChange: (value: boolean) => void;
  thumbnailRowHeight: number; onThumbnailRowHeightChange: (value: number) => void; refreshVersion: number;
  /** Automatic analysis results per series: this series' entry refreshes its gallery and counts only. */
  seriesRevisions?: SeriesRevisions;
  onNavigate: (view: AssetView) => void; onChanged: () => void;
  api?: CharacterApi; hubApi?: CharacterHubApi; shadowApi?: ShadowReviewApi;
  /** 선택한 영상 비교, as in plain folders. */
  onReviewVideos?: (assetIds: string[]) => void;
  /** Album, folder and trash counts after an asset edit; the series screen itself is not reloaded. */
  onMembershipChanged?: () => void;
};
type TrashUndo = { scope: string; removed: { asset: AssetSummary; index: number }[] };
type Editor = { target: CharacterTarget | null; draft: CharacterEditorDraft };
type Picking = { kind: "thumbnail" | "references" | "hero"; ids: string[]; previousAll: boolean };
type SeriesGalleryView = SeriesGalleryFilter | "excluded";
const ordinarySeriesGalleryViews: { value: SeriesGalleryView; label: string }[] = [
  { value: "unclassified", label: "미분류" },
  { value: "all", label: "전체" },
];
/** Character panel trigger: a framed figure, distinct from the generic overflow squares. */
const CharacterPanelIcon = (props: ComponentProps<"svg">) => <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.25} strokeLinecap="square" strokeLinejoin="miter" {...props}>
  <path d="M3 8V3h5M16 3h5v5M21 16v5h-5M8 21H3v-5M10 7h4v4h-4zM7 17l2-3h6l2 3" />
</svg>;
const emptyPage = (): CharacterBrowsePage => ({ items: [], nextCursor: null, totalCount: 0 });
const createRandomPivot = () => crypto.randomUUID().split("-").join("");
type SeriesViewFilters = { mediaFilter: AssetMediaFilter; aspectFilter: AssetAspectFilter; randomPivot: string };
let activeViewFilters: (() => SeriesViewFilters) | null = null;
let prefetchedRandomPivot: string | null = null;
function initialRandomPivot() {
  // StrictMode can call the initializer twice before commit; both must match the hovered request.
  return prefetchedRandomPivot ?? createRandomPivot();
}
function characterBrowseView(sort: AssetSort, filters: SeriesViewFilters): CharacterBrowseView | undefined {
  return sort !== "newest" || filters.mediaFilter !== "all" || filters.aspectFilter !== "all"
    ? { sort, randomPivot: sort === "random" ? filters.randomPivot : null, mediaKind: filters.mediaFilter === "all" ? null : filters.mediaFilter, aspectRatio: filters.aspectFilter === "all" ? null : filters.aspectFilter }
    : undefined;
}
export function seriesFolderBrowseView(sort: AssetSort) {
  const filters = activeViewFilters?.() ?? {
    mediaFilter: "all", aspectFilter: "all",
    randomPivot: sort === "random" ? (prefetchedRandomPivot ??= createRandomPivot()) : "",
  };
  return characterBrowseView(sort, filters);
}
/**
 * Hover prefetch of a series overview: the reads its switch gates on (the first page in `load` and the
 * excluded-count, folder and candidate reads below), with the same arguments, so the switch takes them.
 */
export function prefetchSeriesOverview(seriesId: string, hubApi: Pick<CharacterHubApi, "browse" | "excludedAssets" | "seriesFolders"> = characterHubApi, shadowApi: Pick<ShadowReviewApi, "page"> = shadowReviewApi, options?: { view?: CharacterBrowseView; gateway: LibraryGateway; scope: string; version: number; seriesRevisions?: SeriesRevisions }): Promise<unknown>[] {
  const query = { seriesId, targetId: null, groupId: null, seriesFilter: "unclassified" as const, all: false, after: null, limit: 100, ...(options?.view ? { view: options.view } : {}) };
  const candidates = { offset: 0, limit: 1, seriesId };
  return [
    ...(options ? [prefetchCharacterSuggestions(options.version, options.scope), readSeriesSidebarCounts(options.gateway, options.scope, options.version, options.seriesRevisions && { id: seriesId, revisions: options.seriesRevisions })] : []),
    // Tagged with the series: analysing it drops only these reads (invalidateFolderPrefetch(seriesId)).
    prefetchRead(hubApi, "browse", query, () => hubApi.browse(query), seriesId),
    prefetchRead(hubApi, "excludedAssets", [seriesId, null, 1], () => hubApi.excludedAssets(seriesId, null, 1), seriesId),
    prefetchRead(hubApi, "seriesFolders", seriesId, () => hubApi.seriesFolders(seriesId), seriesId),
    prefetchRead(shadowApi, "page", candidates, () => shadowApi.page(candidates), seriesId),
  ];
}
/** Status that used to sit under each character card; tiles now show only a warning mark when something is wrong. */
function characterStatus(target: CharacterTarget, readiness: S36Readiness | undefined, s36Driven: boolean): { detail: string[]; warning: boolean } {
  const references = activeCharacterReferences(target).length;
  const detail = !target.enabled ? ["자동 분석 꺼짐"] : references < 6 ? [`레퍼런스 ${references}장 · 자동 확정 보류`] : [];
  const s36 = target.enabled && !s36Driven ? readiness : undefined;
  if (s36) detail.push(readinessLabel(s36));
  return { detail, warning: Boolean(s36 && (s36.wrong > 0 || s36.status === "keep")) };
}

export function SeriesBrowser({ requestedAsset, onRequestedAssetHandled, clearSelectionRequest = 0, galleryDrag, albums = [], folderExclusions = [], series, targetId, groupId, targets, groups = [], classifications, galleryLayout, onGalleryLayoutChange, sort = "newest", onSortChange, privacyMode, onPrivacyModeChange, metadataVisible, onMetadataVisibleChange, thumbnailRowHeight, onThumbnailRowHeightChange, refreshVersion, seriesRevisions = NO_SERIES_REVISIONS, onNavigate, onChanged, api = characterApi, hubApi = characterHubApi, shadowApi = shadowReviewApi, onReviewVideos, onMembershipChanged }: Props) {
  void onPrivacyModeChange;
  void onMetadataVisibleChange;
  const { gateway, library } = useLibrary();
  const dataScope = seriesDataScope(gateway, library?.root);
  const previewCache = folderPreviewCache(gateway, library?.root);
  const folderIntent = useFolderPrefetchIntent();
  const suggestions = useCharacterSuggestions(refreshVersion);
  const [hiddenSuggestions, setHiddenSuggestions] = useState<string[]>([]);
  const seriesSuggestions = suggestions.rows.filter(row => row.seriesId === series.classificationId);
  const suggestionsHidden = hiddenSuggestions.includes(series.classificationId);
  const [folderRead, setFolderRead] = useState<{ cache: typeof previewCache; seriesId: string; folders: SeriesFolder[] } | null>(null);
  // Keep the displayed shelf until an uncached series read settles; stale cards cannot act.
  const cachedFolders = previewCache.shelves.get(series.classificationId);
  const retainedFolderRead = folderRead?.cache === previewCache ? folderRead : null;
  const folders = cachedFolders ?? retainedFolderRead?.folders ?? [];
  const folderSeriesId = cachedFolders ? series.classificationId : retainedFolderRead?.seriesId ?? series.classificationId;
  const staleFolders = folderSeriesId !== series.classificationId;
  // `series`: opened from this series' candidate count, so scoped to it; `all`: the overflow entry.
  const [shadowReview, setShadowReview] = useState<false | "series" | "all">(false);
  const [s36Setup, setS36Setup] = useState(false);
  const [candidateCount, setCandidateCount] = useState(0);
  const [candidateLoading, setCandidateLoading] = useState(true);
  const [groupCreateRequest, setGroupCreateRequest] = useState(0);
  const [groupEditRequest, setGroupEditRequest] = useState(0);
  const [readinessVersion, setReadinessVersion] = useState(0);
  const [folderError, setFolderError] = useState<string | null>(null);
  const [folderLoading, setFolderLoading] = useState(true);
  const [page, setPage] = useState<CharacterBrowsePage>(emptyPage);
  const [all, setAll] = useState(false), [loading, setLoading] = useState(true), [busy, setBusy] = useState(false);
  const analysisRevision = seriesRevisions[series.classificationId] ?? 0;
  const galleryRefreshVersion = useCoalescedRefreshVersion(refreshVersion + analysisRevision, loading);
  const [error, setError] = useState<string | null>(null), [editorError, setEditorError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [reload, setReload] = useState(0), [selection, setSelection] = useState(emptySelection);
  const [externalAsset, setExternalAsset] = useState<AssetSummary | null>(null), [viewer, setViewer] = useState<string | null>(null);
  const [editor, setEditor] = useState<Editor | null>(null);
  const [characterOpen, setCharacterOpen] = useState(false);
  const [pickFromSeries, setPickFromSeries] = useState(false);
  const [picking, setPicking] = useState<Picking | null>(null);
  // The 정보 dock as in plain folders: its open state is this device's preference, shared with them.
  const [inspectorOpen, setInspectorOpen] = useInfoPanelPreference();
  const viewerOriginRect = useRef<TileRect | undefined>(undefined);
  const [characterNotice, setCharacterNotice] = useState<CharacterAssignNoticeState | null>(null);
  const characterNoticeId = useRef(0);
  const [assignArtistOpen, setAssignArtistOpen] = useState(false);
  const [converting, setConverting] = useState(false);
  const [referenceSuggestionTarget, setReferenceSuggestionTarget] = useState<CharacterTarget | null>(null);
  const [seriesGalleryState, setSeriesGalleryState] = useState<{ seriesId: string; view: SeriesGalleryView }>(() => ({ seriesId: series.classificationId, view: "unclassified" }));
  const [legacyExcludedCount, setLegacyExcludedCount] = useState(0);
  const [excludedLoading, setExcludedLoading] = useState(true);
  const [trashUndo, setTrashUndo] = useState<TrashUndo | null>(null);
  // 보기 filters, as in a plain folder: they stay while moving between series, groups and characters.
  const [mediaFilter, setMediaFilter] = useState<AssetMediaFilter>("all");
  const [aspectFilter, setAspectFilter] = useState<AssetAspectFilter>("all");
  const [randomPivot, setRandomPivot] = useState(initialRandomPivot);
  const viewFilters = useRef({ mediaFilter, aspectFilter, randomPivot });
  viewFilters.current = { mediaFilter, aspectFilter, randomPivot };
  useLayoutEffect(() => {
    if (prefetchedRandomPivot === viewFilters.current.randomPivot) prefetchedRandomPivot = null;
    const read = () => viewFilters.current;
    activeViewFilters = read;
    return () => { if (activeViewFilters === read) activeViewFilters = null; };
  }, []);
  const generation = useRef(0), pending = useRef(false), saving = useRef(false);
  const loadedScope = useRef<string | null>(null);
  // The scope the shown page belongs to. On a scope switch the previous images stay until the new
  // first page lands, instead of blanking the gallery (no-flash rule, DESIGN.md).
  const [pageScope, setPageScope] = useState<string | null>(null);
  const [preparedPage, setPreparedPage] = useState<{ scope: string; page: CharacterBrowsePage; token: number } | null>(null);
  const painted = useRef<ReactElement<{ inert?: boolean; 'aria-busy'?: boolean; children?: ReactNode }> | null>(null);
  const host = useRef<HTMLElement>(null);
  const swapOwner = useRef({});
  const pickerPages = useRef(new Map<string, CharacterBrowsePage>());
  const returnGallery = useRef<{ scope: string; page: CharacterBrowsePage } | null>(null);
  useLayoutEffect(() => {
    setEditor(null); setPicking(null); setConverting(false); setViewer(null); setExternalAsset(null);
    setSelection(emptySelection()); setCharacterOpen(false); setShadowReview(false); setS36Setup(false);
    setReferenceSuggestionTarget(null); setAll(false); setTrashUndo(null); setMessage(null); setEditorError(null); setCharacterNotice(null); setAssignArtistOpen(false);
    pickerPages.current.clear(); returnGallery.current = null;
  }, [series.classificationId]);
  const current = targets.find(t => t.id === targetId);
  const inspectionTarget = editor ? editor.target : current;
  const inspectionDraft = editor?.draft ?? characterDraft(current ?? null);
  const inspectionEnabled = Boolean((editor || current) && !inspectionTarget?.manualOnly && inspectionDraft.enabled);
  // Only the current character is inspected, never every overview card or gallery asset.
  const referenceInspection = useReferenceRegionInspection({
    seriesId: series.classificationId, targetId: inspectionTarget?.id ?? null,
    assetIds: inspectionDraft.references, draftRegions: inspectionDraft.referenceRegions,
    api: inspectionEnabled ? api.inspectReferenceRegions : undefined,
    revision: `${inspectionTarget?.fingerprint ?? "new"}:${reload}`,
  });
  const characterAttention = current && inspectionEnabled && inspectionTarget?.id === current.id
    ? referenceInspection.error ? "인물 영역 확인 실패 · 캐릭터 정보에서 확인해 주세요."
      : referenceInspection.inspections && needsReferenceConfirmation(referenceInspection.inspections) ? "필요한 인물 확인이 있습니다."
      : null
    : null;
  const currentGroup = groups.find(group => group.id === groupId && group.seriesId === series.classificationId);
  const seriesGalleryView = seriesGalleryState.seriesId === series.classificationId ? seriesGalleryState.view : "unclassified";
  const excludedOnly = seriesGalleryView === "excluded";
  const seriesGalleryViews = legacyExcludedCount > 0
    ? [...ordinarySeriesGalleryViews, { value: "excluded" as const, label: "자동 분류 제외" }]
    : ordinarySeriesGalleryViews;
  // The 보기 sort and filters apply to the series, group and character galleries, not to the
  // pickers or the legacy 자동 분류 제외 list (its own command has no sort or filters).
  const viewApplies = !picking && !(!targetId && !currentGroup && excludedOnly);
  const sorted = viewApplies && Boolean(onSortChange) ? sort : "newest";
  const browseView = viewApplies ? characterBrowseView(sorted, { mediaFilter, aspectFilter, randomPivot }) : undefined;
  const filtered = Boolean(browseView?.mediaKind || browseView?.aspectRatio);
  const members = targets.filter(t => t.seriesClassificationId === series.classificationId);
  // Per-character image counts come from the character index (character folders are hidden from the
  // folder tree, so their tree counts are missing); the folder tree is only a fallback.
  const cachedCounts = sidebarCountCache.peek(gateway, dataScope, refreshVersion);
  const countRevision = useSyncExternalStore(sidebarCountCache.subscribe, () => sidebarCountCache.generation(gateway, dataScope));
  const [sidebarCounts, setSidebarCounts] = useState<Record<string, number> | null>(cachedCounts?.targets ?? null);
  const [settledCounts, setSettledCounts] = useState<{ gateway: LibraryGateway; scope: string; version: number; revision: string } | null>(null);
  const sidebarLoading = Boolean(gateway.characterSidebarCounts && !cachedCounts && (!settledCounts || settledCounts.gateway !== gateway || settledCounts.scope !== dataScope || settledCounts.version !== refreshVersion || settledCounts.revision !== countRevision));
  useEffect(() => {
    if (!gateway.characterSidebarCounts) return;
    let active = true;
    const request = { gateway, scope: dataScope, version: refreshVersion, revision: countRevision };
    void readSeriesSidebarCounts(gateway, dataScope, refreshVersion, { id: series.classificationId, revisions: seriesRevisions }).then(result => { if (active && result) setSidebarCounts(result.targets); }, () => undefined)
      .finally(() => { if (active) setSettledCounts(request); });
    return () => { active = false; };
  }, [gateway, dataScope, refreshVersion, countRevision, reload, series.classificationId, analysisRevision]);
  const characterCounts: Record<string, number> = Object.fromEntries(targets.flatMap(target => {
    const folder = target.linkedClassificationId ? classifications.find(entry => entry.id === target.linkedClassificationId) : undefined;
    const count = (cachedCounts?.targets ?? sidebarCounts)?.[target.id] ?? folder?.totalAssetCount ?? folder?.assetCount;
    return count === undefined ? [] : [[target.id, count] as const];
  }));
  const memberCounts: Record<string, number | undefined> = Object.fromEntries(members.map(target => [target.id, characterCounts[target.id]]));
  const groupedIds = new Set(groups.flatMap(group => group.targetIds));
  const orderedMembers = members.filter(target => currentGroup
    ? currentGroup.targetIds.includes(target.id) : !groupedIds.has(target.id));
  const readiness = useS36Readiness(series.classificationId, readinessVersion);
  const { settings: s36Settings, error: s36Error, enabled: s36CharacterAvailable, excluded: s36CharacterExcluded, toggle: toggleS36Character } = useS36CharacterExclusion(series.classificationId, current?.id ?? null, s36PublicationApi);
  const s36Driven = (targetId: string) => Boolean(s36Settings?.series.includes(series.classificationId) && !s36Settings.excludedTargets.includes(targetId));
  const name = classifications.find(c => c.id === series.classificationId)?.name ?? "시리즈";
  const pickerScope = picking && picking.kind !== "hero" ? `${series.classificationId}:${editor?.target?.id ?? "new"}:${pickFromSeries ? "series" : "character"}:${all}` : null;
  const scope = `${series.classificationId}:${picking ? picking.kind === "hero" ? "pick-hero" : `pick-${editor?.target?.id ?? "new"}-${pickFromSeries}` : targetId ? `character-${targetId}` : currentGroup ? `group-${currentGroup.id}` : `series-${seriesGalleryView}`}:${all}${browseView ? `|${JSON.stringify(browseView)}` : ""}`;
  const ids = page.items.map(a => a.id);
  const selectedIds = [...selection.ids];
  const currentReferenceIds = new Set(current ? [
    ...current.references.flatMap(reference => reference.assetId ? [reference.assetId] : []),
    ...(current.learnedReferences?.flatMap(reference => reference.assetId ? [reference.assetId] : []) ?? []),
  ] : []);
  const selectedReferenceCount = selectedIds.filter(id => currentReferenceIds.has(id)).length;
  const dismissMessage = useCallback((value: null) => { setMessage(value); setTrashUndo(null); }, []);
  useAutoDismiss(message, dismissMessage);
  const dismissCharacterNotice = useCallback((_value: null) => setCharacterNotice(null), []);
  useAutoDismiss(characterNotice ? String(characterNotice.id) : null, dismissCharacterNotice);
  function refresh() { sidebarCountCache.invalidate(gateway, dataScope); suggestions.refresh(); setReload(v => v + 1); onChanged(); }
  async function load(after: string | null = null) {
    if (after && pending.current) return;
    if (!after && pickerScope) {
      const cached = pickerPages.current.get(pickerScope);
      if (cached) { setPage(cached); setPageScope(scope); setLoading(false); setError(null); return; }
    }
    const token = after ? generation.current : ++generation.current;
    pending.current = true; setLoading(true); setError(null);
    try {
      const query = { seriesId: series.classificationId,
        targetId: picking ? picking.kind !== "hero" && !pickFromSeries ? editor?.target?.id ?? null : null : targetId ?? null,
        groupId: picking ? null : currentGroup?.id ?? null,
        ...(picking && picking.kind !== "hero" ? { referenceTargetId: editor?.target?.id ?? "" } : {}),
        ...(!picking && !targetId && !currentGroup && !excludedOnly ? { seriesFilter: seriesGalleryView as SeriesGalleryFilter } : {}),
        all: !picking && !targetId && !currentGroup ? seriesGalleryView === "all" : all, after, limit: 100,
        ...(browseView ? { view: browseView } : {}) };
      const next = !picking && !targetId && !currentGroup && excludedOnly
        ? await hubApi.excludedAssets(series.classificationId, after, 100)
        : await prefetchedRead(hubApi, "browse", query, () => hubApi.browse(query));
      if (token === generation.current && !after && pageScope !== null && scope !== pageScope && !picking) {
        setPreparedPage({ scope, page: next, token });
      } else if (token === generation.current) setPage(old => {
        const value = after ? { ...next,
          items: [...old.items, ...next.items.filter(a => !old.items.some(b => b.id === a.id))],
          unavailableReferenceIds: [...new Set([...(old.unavailableReferenceIds ?? []), ...(next.unavailableReferenceIds ?? [])])],
        } : next;
        if (pickerScope) pickerPages.current.set(pickerScope, value);
        return value;
      });
      if (token === generation.current && !after && (pageScope === null || scope === pageScope || picking)) setPageScope(scope);
    } catch (e) { if (token === generation.current) setError(commandErrorMessage(e, "이미지를 불러오지 못했습니다.")); }
    finally { if (token === generation.current) { pending.current = false; setLoading(false); } }
  }
  useEffect(() => {
    if (!picking && returnGallery.current?.scope === scope) {
      setPage(returnGallery.current.page); setPageScope(scope); returnGallery.current = null; loadedScope.current = scope; setLoading(false); return;
    }
    if (loadedScope.current !== scope) {
      loadedScope.current = scope; setSelection(emptySelection()); setViewer(null);
    }
    void load(); return () => { ++generation.current; cancelSegmentSwap(swapOwner.current); };
  }, [scope, galleryRefreshVersion, reload, hubApi]);
  useEffect(() => {
    if (targetId || currentGroup || picking) return;
    let active = true;
    setExcludedLoading(true);
    void prefetchedRead(hubApi, "excludedAssets", [series.classificationId, null, 1], () => hubApi.excludedAssets(series.classificationId, null, 1))
      .then(result => { if (active) setLegacyExcludedCount(result.totalCount); })
      .catch(() => { if (active) setLegacyExcludedCount(0); })
      .finally(() => { if (active) setExcludedLoading(false); });
    return () => { active = false; };
  }, [hubApi, series.classificationId, targetId, currentGroup?.id, picking, refreshVersion, reload]);
  useEffect(() => {
    if (legacyExcludedCount === 0 && seriesGalleryView === "excluded") {
      setSeriesGalleryState({ seriesId: series.classificationId, view: "unclassified" });
    }
  }, [legacyExcludedCount, series.classificationId, seriesGalleryView]);
  useEffect(() => {
    setFolderError(null);
    if (targetId || currentGroup || picking) return;
    let active = true;
    setFolderLoading(true);
    void prefetchedRead(hubApi, "seriesFolders", series.classificationId, () => hubApi.seriesFolders(series.classificationId)).then(result => {
      if (!active) return;
      const next = result.map(item => {
        const thumbnailAssetId = item.thumbnailAssetId;
        rememberFolderPreview(previewCache.thumbnails, item.classificationId, thumbnailAssetId);
        return { ...item, thumbnailAssetId };
      });
      rememberFolderPreview(previewCache.shelves, series.classificationId, next, 16);
      setFolderRead({ cache: previewCache, seriesId: series.classificationId, folders: next });
    }).catch(error => { if (active) setFolderError(commandErrorMessage(error, "하위 폴더를 불러오지 못했습니다.")); })
      .finally(() => { if (active) setFolderLoading(false); });
    return () => { active = false; };
  }, [hubApi, previewCache, series.classificationId, targetId, currentGroup?.id, Boolean(picking), refreshVersion, reload]);
  useEffect(() => {
    // Pending S36 candidates (automatic + recommended) drive the quiet 후보 N 확인 action
    // on the series count line. Without the runtime the action stays hidden.
    if (targetId || currentGroup || picking) return;
    let active = true;
    setCandidateLoading(true);
    const candidates = { offset: 0, limit: 1, seriesId: series.classificationId };
    void prefetchedRead(shadowApi, "page", candidates, () => shadowApi.page(candidates))
      .then(result => { if (active) setCandidateCount(result.summary.automatic.pending + result.summary.recommended.pending); })
      .catch(() => { if (active) setCandidateCount(0); })
      .finally(() => { if (active) setCandidateLoading(false); });
    return () => { active = false; };
  }, [shadowApi, series.classificationId, targetId, currentGroup?.id, Boolean(picking), readinessVersion]);
  useEffect(() => setSelection(emptySelection()), [clearSelectionRequest]);
  useEffect(() => { if (selection.ids.size === 0) setCharacterOpen(false); }, [selection.ids.size]);
  useEffect(() => {
    if (!characterOpen) return;
    const close = (event: PointerEvent) => {
      if (!(event.target instanceof Element) || !event.target.closest(".asset-selection-bar__character")) setCharacterOpen(false);
    };
    document.addEventListener("pointerdown", close, true);
    return () => document.removeEventListener("pointerdown", close, true);
  }, [characterOpen]);
  useEffect(() => { if (requestedAsset) { setExternalAsset(requestedAsset); setViewer(requestedAsset.id); onRequestedAssetHandled?.(); } }, [requestedAsset]);
  async function action(work: () => Promise<unknown>) {
    if (saving.current) return;
    saving.current = true; setBusy(true); setError(null);
    try { await work(); refresh(); }
    catch (e) { setError(commandErrorMessage(e, "변경을 저장하지 못했습니다.")); }
    finally { saving.current = false; setBusy(false); }
  }
  async function createManualCharacter(nameToCreate: string) {
    const displayName = nameToCreate.trim();
    if (!displayName || !selectedIds.length || saving.current) return;
    saving.current = true; setBusy(true); setError(null);
    try {
      const target = await hubApi.createManualCharacter({ seriesId: series.classificationId, displayName, assetIds: selectedIds });
      setCharacterOpen(false); setSelection(emptySelection()); refresh();
      onNavigate({ kind: "classification", classificationId: series.classificationId, characterId: target.id });
    } catch (e) { setError(commandErrorMessage(e, "캐릭터를 만들지 못했습니다.")); }
    finally { saving.current = false; setBusy(false); }
  }
  async function assignCharacters(chosen: CharacterTarget[], assetIds: string[] = selectedIds) {
    if (!chosen.length || !assetIds.length || saving.current) return;
    saving.current = true; setBusy(true); setError(null);
    try {
      const sameSeries = chosen.filter(target => target.seriesClassificationId === series.classificationId);
      const otherSeries = chosen.filter(target => target.seriesClassificationId !== series.classificationId);
      if (sameSeries.length) {
        // The decision batch takes at most 200 image × character pairs (kept from the old dialog).
        if (assetIds.length * sameSeries.length > 200) throw new Error("이미지 수 × 캐릭터 수는 한 번에 200개까지 지정할 수 있습니다.");
        const available = await api.targets();
        const currentTargets = sameSeries.map(target => {
          const currentTarget = available.find(value => value.id === target.id && value.seriesClassificationId === series.classificationId);
          if (!currentTarget) throw new Error("캐릭터를 다시 선택해 주세요.");
          return currentTarget;
        });
        await api.decideBatch(currentTargets.map(target => ({ targetId: target.id, expectedFingerprint: target.fingerprint, assetIds, decision: "accepted" as const, baselineFingerprint: null, scanId: null })));
      }
      if (otherSeries.length) await moveAssetsToCharacters(otherSeries.map(target => ({ targetId: target.id, expectedFingerprint: target.fingerprint })), assetIds);
      markAssignedTiles(assetIds, chosen[0]!.displayName);
      setCharacterNotice({ id: ++characterNoticeId.current, count: assetIds.length, target: chosen[0]! });
      setCharacterOpen(false); if (assetIds === selectedIds) setSelection(emptySelection()); refresh();
    } catch (e) {
      setError(commandErrorMessage(e, "캐릭터에 넣지 못했습니다."));
      throw e;
    } finally { saving.current = false; setBusy(false); }
  }
  function openEditor(target: CharacterTarget | null) {
    const next = { target, draft: characterDraft(target) };
    pickerPages.current.clear(); setEditor(next); setEditorError(null);
    return next;
  }
  function beginPick(kind: Picking["kind"], pickEditor = editor) {
    setPickFromSeries(false);
    returnGallery.current = { scope, page }; ++generation.current; setPage(emptyPage()); setError(null); // no-flash-ok: entering the picker is a different screen
    setPicking({ kind, previousAll: all, ids: kind === "hero" ? series.heroAssetId ? [series.heroAssetId] : [] : kind === "thumbnail" ? pickEditor?.draft.thumbnail ? [pickEditor.draft.thumbnail] : [] : pickEditor?.draft.references ?? [] });
    setAll(kind === "hero" || Boolean(pickEditor?.target));
  }
  function finishPick(accept: boolean) {
    if (!picking) return;
    if (accept && picking.kind === "hero") void action(() => hubApi.saveSeries({ ...series, heroAssetId: picking.ids[0] ?? null }));
    if (accept && editor && picking.kind !== "hero") setEditor({ ...editor, draft: { ...editor.draft,
      ...(picking.kind === "thumbnail" ? { thumbnail: picking.ids[0] ?? null } : updateCharacterReferences(editor.draft, picking.ids)) } });
    ++generation.current; setAll(picking.previousAll); setPicking(null); setError(null);
  }
  useBackHandler(() => finishPick(false), 85, Boolean(picking));
  function choose(id: string) {
    if (!picking || busy) return;
    if (picking.kind !== "hero" && page.unavailableReferenceIds?.includes(id) && !picking.ids.includes(id)) {
      const asset = page.items.find(item => item.id === id);
      setError(`「${asset?.originalName ?? "이 이미지"}」는 원본 파일이 없어 선택할 수 없습니다. 다른 이미지를 선택하거나 원본을 복구한 뒤 다시 시도해 주세요.`);
      return;
    }
    setError(null);
    if (picking.kind !== "references") { setPicking({ ...picking, ids: [id] }); return; }
    if (picking.ids.includes(id)) setPicking({ ...picking, ids: picking.ids.filter(value => value !== id) });
    else if (picking.ids.length < MAX_CHARACTER_REFERENCES) setPicking({ ...picking, ids: [...picking.ids, id] });
    else setError("레퍼런스는 최대 25장입니다. 먼저 한 장을 해제해 주세요.");
  }
  async function saveEditor() {
    if (!editor || saving.current) return;
    saving.current = true; setBusy(true); setEditorError(null);
    try {
      const { draft, target } = editor;
      const referenceRegions = draftReferenceRegions(draft.referenceRegions, draft.references, characterDraft(target).referenceRegions);
      await api.saveSettings({ id: target?.id ?? null, expectedRevision: target?.revision ?? null,
        seriesClassificationId: series.classificationId, linkedClassificationId: target?.linkedClassificationId ?? null,
        displayName: draft.name.trim(), description: draft.description, thumbnailAssetId: draft.thumbnail, enabled: draft.enabled,
        referenceIds: draft.references,
        // Only choices the user made here travel with the save; automatic regions
        // stay backend-owned and the field is omitted when there is nothing to send.
        ...(Object.keys(referenceRegions).length > 0 ? { referenceRegions } : {}) }, true);
      setEditor(null); refresh();
    } catch (e) { setEditorError(commandErrorMessage(e, "캐릭터 설정을 저장하지 못했습니다.")); onChanged(); }
    finally { saving.current = false; setBusy(false); }
  }
  async function requestHistoricalRefresh(target: CharacterTarget) {
    if (busy || !window.confirm("현재 레퍼런스로 이 시리즈의 미분류 이미지 전체를 확인할까요? 분류 제외와 수동 판단을 보존하며, 백그라운드에서 새 이미지보다 낮은 우선순위로 진행됩니다.")) return;
    setBusy(true); setEditorError(null);
    try {
      const receipt = await hubApi.requestReferenceRefresh(target.id, target.revision);
      setMessage(receipt.eligibleCount > 0
        ? `미분류 이미지 ${receipt.eligibleCount.toLocaleString()}개 갱신을 예약했습니다. 작업 센터에서 진행 상황을 확인할 수 있습니다.`
        : receipt.state === "completed" ? "갱신할 미분류 이미지가 없습니다." : "갱신 대상을 확인하고 있습니다. 작업 센터에서 진행 상황을 확인할 수 있습니다.");
    } catch (reason) {
      setEditorError(commandErrorMessage(reason, "과거 이미지 갱신을 예약하지 못했습니다."));
    } finally { setBusy(false); }
  }
  // FAULT: the character, group or series gallery offers its whole scope (read the same way as the gallery).
  const playFault = useFaultGame();
  const faultScope: FaultScope | null = !picking && (faultAssets(page.items).length > 0 || page.nextCursor !== null)
    ? (signal) => collectPages((after) => !targetId && !currentGroup && excludedOnly
      ? hubApi.excludedAssets(series.classificationId, after, 100)
      : hubApi.browse({ seriesId: series.classificationId, targetId: targetId ?? null, groupId: currentGroup?.id ?? null,
        ...(!targetId && !currentGroup ? { seriesFilter: seriesGalleryView as SeriesGalleryFilter, all: seriesGalleryView === "all" } : { all }), after, limit: 100,
        ...(browseView ? { view: browseView } : {}) }), signal)
    : null;
  const editorTarget = editor?.target ?? null;
  const editorS36 = editorTarget
    ? s36Driven(editorTarget.id) ? "S36 자동 분류 중" : readiness.get(editorTarget.id) ? readinessLabel(readiness.get(editorTarget.id)!) : null
    : null;
  const editorDirty = Boolean(editor && editor.target && JSON.stringify(editor.draft) !== JSON.stringify(characterDraft(editor.target)));
  const editorPanel = <AnchoredPanel open={Boolean(editor) && !picking} onOpenChange={open => { if (open) openEditor(current ?? null); else if (!picking && !busy) setEditor(null); }} title={editor?.target ? `${editor.target.displayName} · 캐릭터 정보` : "새 캐릭터"}
    trigger={current ? <Button size="icon" variant="ghost" className="character-info-trigger" aria-label="캐릭터 편집" aria-description={characterAttention ?? "캐릭터 정보 편집"}><PencilIcon aria-hidden="true" />{characterAttention && <span className="character-info-attention" aria-hidden="true">!</span>}</Button>
      : <Button size="icon" variant="ghost" className="character-info-trigger" aria-label="캐릭터 만들기" aria-description="캐릭터 만들기"><CharacterPanelIcon aria-hidden="true" /></Button>}
    footer={editor ? <>
      <span role="status">{editorDirty ? "저장하지 않은 변경" : ""}</span>
      <Button size="sm" variant={editorDirty || !editor.target ? "primary" : "secondary"} disabled={busy || !editor.draft.name.trim()} onClick={() => void saveEditor()}>{editor.target ? "저장" : "캐릭터 만들기"}</Button>
    </> : undefined}>
    {editor && <CharacterRegistry draft={editor.draft} target={editor.target} seriesId={series.classificationId} privacyMode={privacyMode} busy={busy} error={editorError} api={api} inspection={referenceInspection}
      automationStatus={editorS36}
      onOpenReference={assetId => void (async () => {
        try { const asset = await gateway.getAsset(assetId); setExternalAsset(asset); setViewer(assetId); }
        catch (error) { setEditorError(commandErrorMessage(error, "원본을 열지 못했습니다.")); }
      })()}
      onChange={draft => setEditor({ ...editor, draft })} onPick={beginPick}
      onRecommendReferences={editor.target ? () => { setReferenceSuggestionTarget(editor.target); setEditor(null); } : undefined}
      />}
    {editor?.target && <CharacterTaggerTags key={editor.target.id} targetId={editor.target.id} disabled={busy} />}
  </AnchoredPanel>;
  // Asset edits (heart, trash, 정보) change only the affected tiles, as in plain folders: the sidebar
  // counts, suggestions, page and hub are not reloaded for them.
  const selectedAssets = page.items.filter(asset => selection.ids.has(asset.id));
  const focusedAsset = selection.focusId ? page.items.find(asset => asset.id === selection.focusId) ?? null : null;
  const inspectorAssets = selectedAssets.length > 0 ? selectedAssets : focusedAsset ? [focusedAsset] : [];
  function updateAssets(update: (asset: AssetSummary) => AssetSummary, assetIds: ReadonlySet<string>) {
    setPage(old => ({ ...old, items: old.items.map(asset => assetIds.has(asset.id) ? update(asset) : asset) }));
    setExternalAsset(asset => asset && assetIds.has(asset.id) ? update(asset) : asset);
  }
  const updateAssetSummary = (updated: AssetSummary) => updateAssets(() => updated, new Set([updated.id]));
  async function batch(work: () => Promise<void>, failure: string) {
    if (saving.current) return false;
    saving.current = true; setBusy(true);
    try { await work(); return true; }
    catch (e) { setTrashUndo(null); setMessage(commandErrorMessage(e, failure)); return false; }
    finally { saving.current = false; setBusy(false); }
  }
  const toggleFavorite = (asset: AssetSummary) => void (async () => {
    const favorite = !asset.favorite;
    try {
      await gateway.setAssetFavorite(asset.id, favorite);
      updateAssets(item => ({ ...item, favorite }), new Set([asset.id]));
      onMembershipChanged?.();
    } catch (e) { setTrashUndo(null); setMessage(commandErrorMessage(e, "좋아요를 변경하지 못했습니다.")); }
  })();
  const setAssetsFavorite = (assetIds: string[], favorite: boolean) => void batch(async () => {
    await gateway.setAssetsFavorite(assetIds, favorite);
    updateAssets(item => ({ ...item, favorite }), new Set(assetIds));
    onMembershipChanged?.();
  }, "좋아요를 변경하지 못했습니다.");
  const toggleFocusedFavorite = (asset: AssetSummary) => {
    if (selectedIds.length > 0) setAssetsFavorite(selectedIds, !selectedAssets.every(item => item.favorite));
    else toggleFavorite(asset);
  };
  /** Trash with 실행 취소: the tiles leave in place and come back to the same spots on undo. */
  const trashAssets = (assetIds: string[]) => batch(async () => {
    await gateway.trashAssets(assetIds);
    const gone = new Set(assetIds);
    const removed = page.items.flatMap((asset, index) => gone.has(asset.id) ? [{ asset, index }] : []);
    setPage(old => ({ ...old, items: old.items.filter(asset => !gone.has(asset.id)), totalCount: Math.max(0, old.totalCount - removed.length) }));
    setSelection(old => old.ids.size === 0 && !(old.focusId && gone.has(old.focusId)) ? old : emptySelection());
    if (externalAsset && gone.has(externalAsset.id)) setExternalAsset(null);
    setTrashUndo({ scope, removed });
    setMessage(assetIds.length === 1 ? "휴지통으로 이동했습니다." : `${assetIds.length.toLocaleString("ko-KR")}개 자산을 휴지통으로 이동했습니다.`);
    onMembershipChanged?.();
  }, "자산을 휴지통으로 이동하지 못했습니다.");
  const trashSelection = () => {
    const assetIds = selectedIds.length > 0 ? [...selectedIds] : focusedAsset ? [focusedAsset.id] : [];
    if (assetIds.length) void trashAssets(assetIds);
  };
  const undoTrash = () => void batch(async () => {
    const undo = trashUndo;
    if (!undo) return;
    await gateway.restoreAssets(undo.removed.map(entry => entry.asset.id));
    if (undo.scope === pageScope) setPage(old => {
      const present = new Set(old.items.map(asset => asset.id));
      const items = [...old.items];
      const back = undo.removed.filter(entry => !present.has(entry.asset.id));
      for (const entry of back) items.splice(Math.min(entry.index, items.length), 0, entry.asset);
      return { ...old, items, totalCount: old.totalCount + back.length };
    });
    setTrashUndo(null);
    setMessage("휴지통 이동을 취소했습니다.");
    onMembershipChanged?.();
  }, "휴지통 이동을 취소하지 못했습니다.");
  const viewerItems = externalAsset && !page.items.some(a => a.id === externalAsset.id) ? [externalAsset, ...page.items] : page.items;
  const viewerFolders = movableViewerFolders(classifications);
  const trashViewerAsset = (asset: AssetSummary) => {
    const index = viewerItems.findIndex(item => item.id === asset.id);
    const next = index < 0 ? undefined : viewerItems[index + 1] ?? viewerItems[index - 1];
    void trashAssets([asset.id]).then(done => { if (done) setViewer(next?.id ?? null); });
  };
  const openCharacterPicker = (asset?: AssetSummary) => {
    if (picking || characterOpen) return;
    if (selectedIds.length === 0 && asset) setSelection(old => applySelectionGesture(old, ids, asset.id, { toggle: false, range: false }));
    setCharacterOpen(true);
  };
  const focusAssetOnly = (asset: AssetSummary, preserveSelection = false) => {
    if (preserveSelection) setSelection(old => ({ ...old, focusId: asset.id, anchorId: old.anchorId ?? asset.id }));
    else setSelection(old => focusAsset(old, ids, asset.id));
  };
  const openViewer = (asset: AssetSummary) => { viewerOriginRect.current = visibleTileRect(asset.id); setViewer(asset.id); };
  const excludeFromCharacter = (assetIds: string[]) => current && void action(async () => {
    await api.decide({ targetId: current.id, expectedFingerprint: current.fingerprint, assetIds, decision: "rejected", baselineFingerprint: null, scanId: null });
    setSelection(emptySelection());
  });
  const contextItems: ContextMenuItem[] = picking ? [
    { id: "cancel-pick", label: "이미지 선택 취소", onSelect: () => finishPick(false) },
  ] : [
    ...(onReviewVideos && selectedAssets.length >= 2 && selectedAssets.length <= 100 && selectedAssets.every(asset => asset.media.kind === "video")
      ? [{ id: "video-similarity", label: "선택한 영상 비교", disabled: busy, onSelect: () => onReviewVideos([...selectedIds]) }]
      : []),
    ...libraryContextItems({ count: selectedIds.length, busy, albums,
      sourceUrls: page.items.filter(asset => selection.ids.has(asset.id)).map(asset => asset.sourceUrl), onMessage: setMessage,
      onAlbum: id => void batch(async () => { await gateway.patchAssetAlbums({ assetIds: selectedIds, addAlbumIds: [id], removeAlbumIds: [] }); onMembershipChanged?.(); }, "앨범에 추가하지 못했습니다.") }),
    ...faultSelectionItem(playFault, selectedAssets),
    ...(gateway.artists ? [{ id: "assign-artist", label: "작가 지정", disabled: busy || !selectedIds.length, onSelect: () => setAssignArtistOpen(true) }] : []),
    { id: "info", label: "정보 열기", onSelect: () => setInspectorOpen(true) },
    { id: "refresh", label: "새로고침", onSelect: refresh },
    { id: "trash", label: "휴지통으로", destructive: true, disabled: busy || !selectedIds.length, onSelect: trashSelection },
  ];
  const faultItem = playFault && faultScope ? [{ id: "fault", label: "FAULT로 플레이", onSelect: () => playFault(faultScope) }] : [];
  const characterMenuItems = current ? [
    ...faultItem,
    ...(current.ready && !current.manualOnly ? [{ id: "historical-refresh", label: "과거 미분류 이미지 갱신", disabled: busy, onSelect: () => void requestHistoricalRefresh(current) }] : []),
    { id: "convert-folder", label: "일반 폴더로 전환", disabled: busy, onSelect: () => { setEditor(null); setConverting(true); } },
    ...(s36CharacterAvailable ? [{ id: "s36-exclusion", label: "S36 제외", checked: s36CharacterExcluded, disabled: busy, onSelect: () => toggleS36Character() }] : []),
  ] : [];
  const seriesMenuItems = [
    ...(!excludedOnly ? [{ id: "create-group", label: "그룹 만들기", onSelect: () => setGroupCreateRequest(v => v + 1) }] : []),
    { id: "pick-cover", label: "시리즈 표지 선택", onSelect: () => beginPick("hero") },
    ...(series.heroAssetId ? [{ id: "clear-cover", label: "시리즈 표지 해제", onSelect: () => void action(() => hubApi.saveSeries({ ...series, heroAssetId: null })) }] : []),
    ...(s36Settings || s36Error ? [{ id: "s36-setup", label: "S36 자동 분류 설정", onSelect: () => setS36Setup(true) }] : []),
    { id: "s36-review", label: "S36 시험 채점 확인", onSelect: () => setShadowReview("all") },
    ...faultItem,
  ];
  const s36Stalled = Boolean(s36Settings?.series.includes(series.classificationId) && !s36Settings.scoringEnabled);
  // Recovery surfaces only while automation is actually off or stalled.
  const automationRecovery = !series.autoClassify ? <Button size="sm" variant="ghost" disabled={busy || Boolean(picking)} onClick={() => void action(() => hubApi.saveSeries({ ...series, autoClassify: true }))}>자동 분류 다시 켜기</Button>
    : s36Stalled && !current && !currentGroup ? <S36ScoringWarning disabled={busy || Boolean(picking)} onChanged={() => { setReadinessVersion(v => v + 1); refresh(); }} /> : null;
  const focusedName = current?.displayName ?? currentGroup?.name;
  // A character inside a group shows the group in its path: series › group › character.
  const currentCharacterGroup = current ? groups.find(group => group.seriesId === series.classificationId && group.targetIds.includes(current.id)) : undefined;
  const currentStatus = current ? characterStatus(current, readiness.get(current.id), s36Driven(current.id)) : null;
  const candidateReview = !picking && !current && !currentGroup && candidateCount > 0 && s36Settings?.series.includes(series.classificationId)
    ? <Button size="sm" variant="ghost" className="series-candidate-review" disabled={busy} aria-description="S36 자동 분류가 판단을 기다리는 후보를 하나씩 확인" onClick={() => setShadowReview("series")}>후보 {candidateCount.toLocaleString()} 확인</Button>
    : null;
  const selectionView: AssetView = { kind: "classification", classificationId: series.classificationId, ...(targetId ? { characterId: targetId } : {}), ...(currentGroup ? { characterGroupId: currentGroup.id } : {}) };
  const setSelectionFavorite = (favorite: boolean) => setAssetsFavorite(selectedIds, favorite);
  const characterExtraActions = current ? selectedReferenceCount > 0
    ? <Button size="sm" variant="ghost" disabled={busy} aria-description="선택에 참조 이미지가 포함되어 있습니다. 캐릭터 정보에서 먼저 해제하거나 교체해 주세요." onClick={() => openEditor(current)}>참조 설정 · {selectedReferenceCount.toLocaleString()}</Button>
    : <Button size="sm" variant="ghost" disabled={busy || selectedIds.length > 200} aria-description="한 번에 최대 200장" onClick={() => excludeFromCharacter(selectedIds)}>이 캐릭터에서 빼기</Button>
    : !picking && !currentGroup && excludedOnly ? <Button size="sm" variant="ghost" disabled={busy || selectedIds.length > 200} onClick={() => void action(async () => {
      await hubApi.setSeriesAssetExcluded({ seriesId: series.classificationId, assetIds: selectedIds, excluded: false });
      setSelection(emptySelection());
    })}>분류 다시 시작</Button>
    : undefined;
  // The viewer opened from a character offers its exclusion, as on the tablet; references stay protected.
  const viewerExtraActions = current ? (asset: AssetSummary) => currentReferenceIds.has(asset.id) ? null
    : <Button className="asset-viewer__vbtn" size="icon" variant="ghost" aria-label="이 캐릭터에서 빼기" aria-description={`${current.displayName}에서 빼기`} disabled={busy} onClick={() => {
      const index = viewerItems.findIndex(item => item.id === asset.id);
      const next = viewerItems[index + 1] ?? viewerItems[index - 1];
      setViewer(next && next.id !== asset.id ? next.id : null);
      excludeFromCharacter([asset.id]);
    }}><UserMinusIcon aria-hidden="true" /></Button> : undefined;
  // Date headings stay off while the series shelf heads the gallery, as plain folders do under their folder shelf.
  const shelfShown = !picking && !excludedOnly && !current;
  // The first page alone is not ready: the shelf and its count/header reads also change layout.
  const shelfLoading = !picking && !current && (sidebarLoading || (!currentGroup && ((folderLoading && !cachedFolders) || suggestions.loading || candidateLoading || excludedLoading || (!s36Settings && !s36Error))));
  useEffect(() => {
    if (!pcPerfEnabled() || loading || shelfLoading || pageScope !== scope || error) return;
    return pcFolderReady(pcFolderScope({ kind: "classification", classificationId: series.classificationId, characterId: targetId, characterGroupId: groupId }), host.current,
      () => galleryFirstScreen(host.current, page.items, { layout: galleryLayout, groupDates: !shelfShown }).length, targetId || groupId ? "character" : "series");
  }, [loading, shelfLoading, pageScope, scope, error, series.classificationId, targetId, groupId, page.items, galleryLayout, shelfShown]);
  useEffect(() => {
    if (!preparedPage || preparedPage.scope !== scope || preparedPage.token !== generation.current || shelfLoading) return;
    let active = true;
    // The whole READY_CAP_MS: a tile past a shorter cap would mount late and fade in on its own.
    void preloadImages(privacyMode ? [] : firstScreenImages(preparedPage.page.items), READY_CAP_MS).then(() => {
      if (!active || preparedPage.token !== generation.current) return;
      const commit = () => {
        setPage(preparedPage.page); setPageScope(scope); setPreparedPage(null);
      };
      const segment = pageScope?.replace(/:series-(unclassified|all|excluded):/, ':series:') === scope.replace(/:series-(unclassified|all|excluded):/, ':series:');
      if (segment) swapSegment(swapOwner.current, {
        forward: seriesGalleryView === 'all', target: host.current?.querySelector<HTMLElement>('.asset-gallery__scroll'),
        still: host.current?.querySelector<HTMLElement>('.folder-filter'), commit,
      });
      else commit();
    });
    return () => { active = false; };
  }, [preparedPage, scope, shelfLoading, privacyMode, pageScope, seriesGalleryView, folders, targets, suggestions.rows, suggestionsHidden, galleryLayout]);
  /**
   * What a switch waits for: the first screen only, gallery tiles first (those with a thumbnail),
   * then the strip cards in view. The rest loads lazily after the commit.
   */
  function firstScreenImages(items: AssetSummary[]) {
    const tiles = galleryFirstScreen(host.current, items, { layout: galleryLayout }).filter(item => tileHasThumbnail(item)).map(item => tileThumbnailUrl(item));
    const strip = !current && !excludedOnly ? seriesShelfCardImages({
      members, groups: groups.filter(group => group.seriesId === series.classificationId), activeGroupId: currentGroup?.id,
      suggestions: suggestionsHidden ? [] : seriesSuggestions,
      folders: staleFolders ? [] : folders.filter(folder => classifications.some(entry => entry.id === folder.classificationId)),
    }).slice(0, shelfCardsInView(host.current)).flat() : [];
    return [...new Set([...tiles, ...strip])];
  }
  const content = <section ref={host} className="series-browser" aria-label={focusedName ?? name} aria-busy={loading || shelfLoading} onKeyDown={event => {
    if (picking || event.defaultPrevented || event.ctrlKey || event.metaKey || event.altKey || event.key.toLowerCase() !== "i" || (event.target as HTMLElement).closest("input, textarea, select, [contenteditable='true']")) return;
    event.preventDefault(); setInspectorOpen(open => !open);
  }}>
    <AssetToolbar title={focusedName ? [name, current && currentCharacterGroup?.name, focusedName].filter(Boolean).join(" / ") : name}
      view={selectionView} classifications={classifications} albums={albums}
      galleryLayout={galleryLayout} onGalleryLayoutChange={onGalleryLayoutChange} thumbnailRowHeight={thumbnailRowHeight} onThumbnailRowHeightChange={onThumbnailRowHeightChange}
      metadataVisible={metadataVisible} onMetadataVisibleChange={onMetadataVisibleChange} privacyMode={privacyMode} onPrivacyModeChange={onPrivacyModeChange}
      sort={sorted} onSortChange={viewApplies ? onSortChange : undefined} onReshuffle={() => setRandomPivot(createRandomPivot())}
      mediaFilter={mediaFilter} onMediaFilterChange={viewApplies ? setMediaFilter : undefined}
      aspectFilter={aspectFilter} onAspectFilterChange={viewApplies ? setAspectFilter : undefined}
      inspectorOpen={inspectorOpen} inspectorAvailable onInspectorOpenChange={setInspectorOpen}
      status={automationRecovery} actions={automationRecovery} ariaLabel="시리즈 도구"
      titleContent={focusedName ? <span className="series-breadcrumb"><button onClick={() => onNavigate({ kind: "classification", classificationId: series.classificationId })}>{name}</button><ChevronRightIcon aria-hidden="true" />{current && currentCharacterGroup && <><button onClick={() => onNavigate({ kind: "classification", classificationId: series.classificationId, characterGroupId: currentCharacterGroup.id })}>{currentCharacterGroup.name}</button><ChevronRightIcon aria-hidden="true" /></>}<span>{focusedName}</span>{!current && <small className="series-header-count">{page.totalCount.toLocaleString()}장</small>}</span> : name}
      trailingAccessory={<div className="series-header-actions">
        {!picking && (!currentGroup || editor) && editorPanel}
        {!picking && current && <Menu label="캐릭터 더보기" disabled={busy} trigger={<EllipsisHorizontalIcon aria-hidden="true" />} items={characterMenuItems} />}
        {!current && !currentGroup && !picking && <Menu label="시리즈 더보기" disabled={busy} trigger={<EllipsisHorizontalIcon aria-hidden="true" />} items={seriesMenuItems} />}
        {currentGroup && !picking && <Menu label="그룹 더보기" disabled={busy} trigger={<UserGroupIcon aria-hidden="true" />} items={[
          { id: "edit-group", label: "그룹 편집", icon: <PencilIcon aria-hidden="true" />, onSelect: () => setGroupEditRequest(v => v + 1) },
          ...faultItem,
        ]} />}
      </div>} />
    {picking && <div className="series-picking" role="region" aria-label="갤러리 이미지 선택">
      <div className="series-picking__title"><strong>{picking.kind === "references" ? `레퍼런스 선택 · ${picking.ids.length}/${MAX_CHARACTER_REFERENCES}` : picking.kind === "hero" ? "히어로 이미지 선택" : "대표 이미지 선택"}</strong><small>{picking.kind === "hero" ? name : editor?.target ? `${editor.target.displayName} 캐릭터 폴더 · 다른 캐릭터와 공유된 이미지는 제외됩니다` : "다른 캐릭터의 이미지는 제외됩니다"}</small></div>
      <div className="series-picking__chosen">{picking.ids.map((id,i) => <button key={id} aria-label={`선택 이미지 ${i + 1} 해제`} onClick={() => setPicking({ ...picking, ids: picking.ids.filter(v => v !== id) })}>{privacyMode ? <span className="privacy-mask" aria-label="비공개 모드"/> : <AssetImage src={thumbnailUrl(id)} alt="" />}<span>×</span></button>)}</div>
      <Button size="sm" disabled={busy || !picking.ids.length} onClick={() => finishPick(true)}>완료</Button><Button size="sm" variant="ghost" onClick={() => finishPick(false)}>취소</Button>
    </div>}
    <div className="series-browser__body asset-browser__workspace" data-info-open={inspectorOpen}>
    <ContextMenu items={contextItems}><div className="series-gallery" aria-busy={loading} inert={pageScope !== scope && page.items.length > 0 ? true : undefined} onContextMenu={event => {
      if (picking) return;
      const id = (event.target as HTMLElement).closest<HTMLElement>("[data-asset-id]")?.dataset.assetId;
      if (id && !selection.ids.has(id)) setSelection(old => applySelectionGesture(old, ids, id, { range: false, toggle: false }));
    }}>
      <AssetGallery {...(!picking ? galleryDrag : {})} intro={<>
        {!picking && current && <div className="series-character-folder-head"><div className="folder-shelf__label character-group-heading"><span>이미지</span><span className="character-group-heading__count">{page.totalCount.toLocaleString("ko-KR")}</span></div></div>}
        {!picking && !excludedOnly && <SeriesShelf hidden={Boolean(current)} scope={`${library?.root ?? ""}:${series.classificationId}:${currentGroup?.id ?? ""}`} privacyKey={String(privacyMode)} ready={!shelfLoading && (Boolean(currentGroup) || (!staleFolders && (!folderLoading || Boolean(cachedFolders))) || Boolean(folderError))}>
          <CharacterGroups key={`${library?.root ?? ""}:${series.classificationId}`} seriesId={series.classificationId} members={members} groups={groups.filter(group => group.seriesId === series.classificationId)} activeGroupId={currentGroup?.id} privacyMode={privacyMode} memberCounts={memberCounts}
            onOpenGroup={id => onNavigate({ kind: "classification", classificationId: series.classificationId, ...(id ? { characterGroupId: id } : {}) })}
            onGroupsChanged={onChanged} suggestionCount={currentGroup ? 0 : seriesSuggestions.length}
            suggestionCards={!currentGroup && !suggestionsHidden ? seriesSuggestions.map(suggestion => <CharacterSuggestionTile key={suggestion.tag} suggestion={suggestion} state={suggestions} privacyMode={privacyMode} onChanged={onChanged} />) : undefined}
            headerAccessory={!currentGroup ? <>{candidateReview}{seriesSuggestions.length > 0 && <Button size="sm" variant="ghost" onClick={() => setHiddenSuggestions(ids => suggestionsHidden ? ids.filter(id => id !== series.classificationId) : [...ids, series.classificationId])}>{suggestionsHidden ? "제안 보기" : "제안 숨기기"}</Button>}</> : undefined} groupCreateRequest={groupCreateRequest} groupEditRequest={groupEditRequest}
            folderCards={!staleFolders && folders.length > 0 ? folders.map(item => {
              const folder = classifications.find(folder => folder.id === item.classificationId);
              if (!folder) return null;
              const exclusion = folderExclusionItem(folder.id, classifications, folderExclusions, excluded => void action(() => hubApi.setFolderExcluded(folder.id, excluded)));
              const excluded = folderExclusions.includes(folder.id) || exclusion.disabled;
              return <article className={`series-character folder-shelf__card${excluded ? " series-character--excluded" : ""}`} key={folder.id} inert={staleFolders}>
                <button disabled={staleFolders} className="series-character__open" aria-label={`${folder.name} 폴더 열기`} aria-description={excluded ? "캐릭터 분류 제외" : "일반 폴더"} {...folderIntent({ kind: "classification", classificationId: folder.id })} onClick={() => onNavigate({ kind: "classification", classificationId: folder.id })}>
                  {privacyMode ? <span className="series-character__placeholder privacy-mask" aria-label="비공개 모드"/> : item.thumbnailAssetId ? <StableImage draggable={false} loading="lazy" src={folderCardImage(item)!} alt="" /> : <span className="series-character__placeholder"><FolderIcon aria-hidden="true" />일반 폴더</span>}
                  {excluded && <span className="series-character__tag" aria-hidden="true">제외</span>}
                  <strong><FolderIcon className="character-group-card__icon" aria-hidden="true" /><span className="series-character__name">{folder.name}</span></strong>
                  {(folder.totalAssetCount ?? folder.assetCount) !== undefined && <small className="folder-shelf__meta">{(folder.totalAssetCount ?? folder.assetCount)!.toLocaleString("ko-KR")}장</small>}
                </button>
                <Menu label={`${folder.name} 폴더 더보기`} triggerClassName="series-character__info" disabled={busy || staleFolders} trigger={<EllipsisHorizontalIcon aria-hidden="true" />} items={[exclusion]} />
              </article>;
            }) : undefined}>{visibleMembers => <>{visibleMembers.map(target => {
              const status = characterStatus(target, readiness.get(target.id), s36Driven(target.id));
              const description = [...(status.warning ? ["확인 필요"] : []), ...status.detail].join(" · ");
              const index = orderedMembers.findIndex(member => member.id === target.id);
              const move = (direction: number) => void action(() => invoke("move_character_folder", {
                seriesId: series.classificationId, targetId: target.id, groupId: currentGroup?.id ?? null, direction,
              }));
              return <ContextMenu key={target.id} items={[
                { id: "move-up", label: "위로 이동", disabled: busy || index === 0, onSelect: () => move(-1) },
                { id: "move-down", label: "아래로 이동", disabled: busy || index === orderedMembers.length - 1, onSelect: () => move(1) },
              ]}><article className="series-character folder-shelf__card">
              <button className="series-character__open" aria-label={`${target.displayName} 열기`} aria-description={description || undefined} onClick={() => onNavigate({ kind: "classification", classificationId: series.classificationId, characterId: target.id })}>
                {privacyMode ? <span className="series-character__placeholder privacy-mask" aria-label="비공개 모드"/> : characterCardImage(target) ? <StableImage draggable={false} loading="lazy" src={characterCardImage(target)!} alt="" /> : <span className="series-character__placeholder"><UserIcon aria-hidden="true" />대표 이미지</span>}
                <strong><UserIcon className="folder-shelf__icon" aria-hidden="true" />{status.warning && <span className="series-character__warning" aria-hidden="true">!</span>}<span className="series-character__name">{target.displayName}</span></strong>
                <small className="folder-shelf__meta" aria-hidden={memberCounts[target.id] === undefined || undefined}>{memberCounts[target.id] === undefined ? null : `${memberCounts[target.id]!.toLocaleString("ko-KR")}장`}</small>
              </button>
              <Button className="series-character__info" size="icon" variant="ghost" aria-label={`${target.displayName} 편집`} aria-description="캐릭터 편집" onClick={() => openEditor(target)}><PencilIcon aria-hidden="true" /></Button>
            </article></ContextMenu>;
            })}</>}</CharacterGroups>
        </SeriesShelf>}
        {!current && suggestions.error && <p role="alert">{suggestions.error}<Button size="sm" onClick={suggestions.refresh}>다시 시도</Button></p>}
        {!current && suggestions.message && <Toast onDismiss={suggestions.dismissMessage}>{suggestions.message}</Toast>}
        {folderError && <p className="character-message" role="alert">{folderError}<Button size="sm" onClick={() => setReload(v => v + 1)}>다시 시도</Button></p>}
        {!picking && currentStatus && currentStatus.detail.length > 0 && <p className={`series-character-status${currentStatus.warning ? " series-character-status--warning" : ""}`}>{currentStatus.detail.join(" · ")}</p>}
        {!picking && current?.description && <p className="series-description">{current.description}</p>}
        {picking && picking.kind !== "hero" && editor?.target ? <div className="series-gallery-heading"><h3>{pickFromSeries ? "시리즈에서 이미지 선택" : `${editor.target.displayName} 캐릭터 폴더`}<small>{page.totalCount}</small></h3><Button size="sm" variant="ghost" onClick={() => setPickFromSeries(v => !v)}>{pickFromSeries ? "캐릭터 폴더로 돌아가기" : "시리즈에서 이미지 찾기"}</Button></div>
          : !picking && !current && !currentGroup ? <FolderFilterControl
            label="시리즈 이미지 필터"
            options={seriesGalleryViews.map(filter => ({ ...filter, ...(seriesGalleryView === filter.value ? { count: page.totalCount } : {}) }))}
            value={seriesGalleryView}
            onChange={value => { setSeriesGalleryState({ seriesId: series.classificationId, view: value }); setSelection(emptySelection()); }}
          />
          : picking && <div className="series-gallery-heading"><h3>{picking.kind === "hero" ? "히어로 이미지 선택" : all ? "선택 가능한 전체" : "미분류"}<small>{page.totalCount}</small></h3>{picking.kind !== "hero" && <Button size="sm" variant="ghost" aria-pressed={all} onClick={() => setAll(v => !v)}>{all ? "미분류만 보기" : "전체 보기"}</Button>}</div>}
        {picking && picking.kind !== "hero" && Boolean(page.unavailableReferenceIds?.length) && <p className="character-message" role="status">원본이 없는 이미지는 선택할 수 없습니다. 썸네일은 남아 있을 수 있습니다.</p>}
        {error && <p className="character-message" role="alert">{error}<Button size="sm" onClick={() => { pickerPages.current.clear(); setReload(v => v + 1); }}>다시 시도</Button></p>}
        {!loading && !error && !page.items.length && filtered && <EmptyState className="series-gallery__empty" title="조건에 맞는 이미지가 없습니다" action={<Button size="sm" variant="ghost" onClick={() => { setMediaFilter("all"); setAspectFilter("all"); }}>필터 초기화</Button>} />}
        {!loading && !error && !page.items.length && !filtered && <EmptyState className="series-gallery__empty" title={picking ? "선택할 수 있는 이미지가 없습니다" : current ? "이 캐릭터의 이미지가 없습니다" : currentGroup ? "이 그룹에 연결된 이미지가 없습니다" : seriesGalleryView === "all" ? "이 시리즈에 이미지가 없습니다" : excludedOnly ? "자동 분류에서 제외한 이미지가 없습니다" : "미분류 이미지가 없습니다"} />}
      </>} layout={galleryLayout} groupDates={!shelfShown && (sorted === "newest" || sorted === "oldest")} favoritesView={sorted === "favorites"} infoOpen={inspectorOpen} scrubberHidden={viewer !== null} items={page.items} scopeKey={pageScope ?? undefined} navigationScopeKey={pageScope?.replace(/:series-(unclassified|all|excluded):/, ':series:')} totalCount={page.totalCount} metadataVisible={metadataVisible} privacyMode={privacyMode} targetRowHeight={thumbnailRowHeight}
        captionLabel={picking && picking.kind !== "hero" ? asset => page.unavailableReferenceIds?.includes(asset.id) ? "원본 없음 · 선택 불가" : null : undefined}
        selectedAssetIds={picking ? new Set(picking.ids) : selection.ids} focusAssetId={picking ? null : selection.focusId}
        hasNextPage={Boolean(page.nextCursor) && !loading && !error && pageScope === scope} onLoadNextPage={() => void load(page.nextCursor)}
        onSelectionGesture={(a,gesture) => picking ? choose(a.id) : setSelection(old => applySelectionGesture(old, ids, a.id, gesture))}
        onFocusAsset={picking ? undefined : focusAssetOnly}
        onSelectAll={picking ? undefined : () => setSelection(old => selectAllLoaded(old, ids))} onClearSelection={() => picking ? setPicking({ ...picking, ids: [] }) : setSelection(emptySelection())}
        onToggleFavorite={picking ? undefined : toggleFavorite} onToggleFocusedFavorite={picking ? undefined : toggleFocusedFavorite}
        onDeleteSelection={picking ? undefined : trashSelection} onAssignCharacter={picking ? undefined : openCharacterPicker}
        onToggleInfo={picking ? undefined : () => setInspectorOpen(open => !open)}
        onEscape={picking ? undefined : () => { if (inspectorOpen) setInspectorOpen(false); else setSelection(emptySelection()); }}
        onRetryVideo={asset => void gateway.retryVideoPreparation(asset.id).then(() => gateway.preparePendingVideos(1)).then(() => setReload(v => v + 1)).catch(e => setMessage(commandErrorMessage(e, "미리보기 준비를 다시 시작하지 못했습니다.")))}
        onMoveFocus={picking ? undefined : (delta,extend) => setSelection(old => moveSelectionFocus(old, ids, delta, extend))} onOpen={a => picking ? choose(a.id) : openViewer(a)} />
      {!picking && selection.ids.size > 0 && <SelectionBar
        view={selectionView}
        selectedCount={selectedIds.length}
        batchPending={busy}
        characterOpen={characterOpen}
        onCharacterToggle={() => characterOpen ? setCharacterOpen(false) : openCharacterPicker()}
        onAssignArtist={gateway.artists ? () => setAssignArtistOpen(true) : undefined}
        characterPicker={<CharacterAssignPicker assetIds={selectedIds} targets={targets} groups={groups} classifications={classifications} counts={characterCounts} privacyMode={privacyMode} busy={busy}
          scopeSeriesId={series.classificationId} currentTargetId={current?.id} onCreate={!current && !currentGroup && !excludedOnly ? nameToCreate => createManualCharacter(nameToCreate) : undefined}
          onAssign={assignCharacters} onClose={() => setCharacterOpen(false)} />}
        extraActions={characterExtraActions}
        onFavorite={setSelectionFavorite}
        onTrash={trashSelection}
        onClearSelection={() => setSelection(emptySelection())}
      />}
    </div></ContextMenu>
    <AssetInspector presentation="docked" assets={inspectorAssets} classifications={classifications} privacyMode={privacyMode} open={inspectorOpen} onOpenChange={setInspectorOpen} onOpenAsset={openViewer} onOpenArtist={creatorKey => onNavigate({ kind: "creator", creatorKey })} onAssetUpdated={updateAssetSummary} onAutoTagFilterApplied={() => onNavigate({ kind: "classification", classificationId: null })} />
    </div>
    {message && <Toast actionLabel={trashUndo ? "실행 취소" : undefined} onAction={trashUndo ? undoTrash : undefined} actionDisabled={busy} onDismiss={() => dismissMessage(null)}>{message}</Toast>}
    {characterNotice && <CharacterAssignToast notice={characterNotice} privacyMode={privacyMode} busy={busy} onDismiss={() => setCharacterNotice(null)} onOpen={() => {
      const target = characterNotice.target;
      if (target.seriesClassificationId) onNavigate({ kind: "classification", classificationId: target.seriesClassificationId, characterId: target.id });
      setCharacterNotice(null);
    }} />}
    {assignArtistOpen && selectedIds.length > 0 && <AssignArtistDialog assetIds={selectedIds} privacyMode={privacyMode} onClose={() => setAssignArtistOpen(false)}
      onAssigned={(_artistId, label) => { setAssignArtistOpen(false); setTrashUndo(null); setMessage(`${selectedIds.length.toLocaleString("ko-KR")}장을 ${label}에 붙였어요`); setSelection(emptySelection()); }} />}
    {referenceSuggestionTarget && <ReferenceCandidateDialog
      target={referenceSuggestionTarget}
      privacyMode={privacyMode}
      api={hubApi}
      onClose={() => setReferenceSuggestionTarget(null)}
      onSaved={() => { setReferenceSuggestionTarget(null); refresh(); }}
    />}
    {converting && current && <CharacterConversion targetId={current.id} onClose={() => setConverting(false)} onConverted={folderId => { setConverting(false); refresh(); onNavigate({ kind: "classification", classificationId: folderId }); }} />}
    {shadowReview && <ShadowReview onClose={() => { setShadowReview(false); setReadinessVersion(v => v + 1); }} onChanged={refresh} privacyMode={privacyMode} api={shadowApi} decisions={api} series={shadowReview === "series" ? { id: series.classificationId, name } : undefined} />}
    {s36Setup && <Dialog open title="S36 자동 분류" onClose={() => setS36Setup(false)}>
      <S36SeriesControl seriesId={series.classificationId} seriesName={name} disabled={busy} onChanged={refresh} readiness={readiness} />
    </Dialog>}
    <AssetViewer originRect={viewerOriginRect.current} items={viewerItems} activeId={viewer} onActiveIdChange={setViewer} onClose={() => { viewerOriginRect.current = undefined; setViewer(null); }} privacyMode={privacyMode} onAssetOpened={a => gateway.recordAssetOpened(a.id, new Date().toISOString())}
      onToggleFavorite={toggleFavorite} onTrash={trashViewerAsset}
      totalCount={page.totalCount + viewerItems.length - page.items.length} classifications={classifications}
      albums={albums} onAddToAlbum={(asset, albumId) => void (async () => {
        try { await gateway.patchAssetAlbums({ assetIds: [asset.id], addAlbumIds: [albumId], removeAlbumIds: [] }); updateAssetSummary(await gateway.getAsset(asset.id)); onMembershipChanged?.(); setTrashUndo(null); setMessage("앨범에 추가했습니다."); }
        catch (e) { setTrashUndo(null); setMessage(commandErrorMessage(e, "앨범에 추가하지 못했습니다.")); }
      })()}
      folders={viewerFolders} onMoveToFolder={(asset, classificationId) => void (async () => {
        try { await gateway.setAssetClassification({ assetIds: [asset.id], classificationId }); refresh(); onMembershipChanged?.(); setTrashUndo(null); setMessage("폴더로 이동했습니다."); }
        catch (e) { setTrashUndo(null); setMessage(commandErrorMessage(e, "폴더로 이동하지 못했습니다.")); }
      })()}
      renderCharacterPicker={(asset, close) => <CharacterAssignPicker assetIds={[asset.id]} targets={targets} groups={groups} classifications={classifications} counts={characterCounts} privacyMode={privacyMode} busy={busy}
        scopeSeriesId={series.classificationId} currentTargetId={current?.id} onAssign={chosen => assignCharacters(chosen, [asset.id])} onClose={close} />}
      renderInfo={asset => <AssetInfoPanel preview={false} assets={[asset]} classifications={classifications} privacyMode={privacyMode} onOpenArtist={creatorKey => onNavigate({ kind: "creator", creatorKey })} onAssetUpdated={updateAssetSummary} onAutoTagFilterApplied={() => onNavigate({ kind: "classification", classificationId: null })} />}
      renderExtraActions={viewerExtraActions}
      onNearEnd={page.nextCursor && !loading && !error && pageScope === scope ? () => void load(page.nextCursor) : undefined} />
  </section>;
  // Retain the whole painted screen, not only its gallery data: new chrome must never
  // label the previous character's images. The gallery stays mounted across publication.
  if (pageScope !== null && pageScope !== scope && painted.current && !picking) return error
    ? cloneElement(painted.current, { inert: false, 'aria-busy': false }, ...(Array.isArray(painted.current.props.children) ? painted.current.props.children : [painted.current.props.children]),
      <p role="alert">{error}<Button size="sm" onClick={() => setReload(value => value + 1)}>다시 시도</Button></p>)
    : cloneElement(painted.current, { inert: true, 'aria-busy': true });
  painted.current = content;
  return content;
}
