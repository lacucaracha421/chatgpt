import { SeriesShelf } from "./SeriesShelf";
import { AssetImage } from "../privacy/AssetImage";
import { folderPreviewCache, rememberFolderPreview } from "../assets/folderPreviewCache";
import { AssetStableImage as StableImage } from "../privacy/AssetImage";
import { CharacterSuggestionTile, useCharacterSuggestions } from "./suggestions/CharacterSuggestions";
import { invoke } from "@tauri-apps/api/core";
import { useCoalescedRefreshVersion } from "../shared/useCoalescedRefreshVersion";
import { useEffect, useLayoutEffect, useRef, useState, type ComponentProps } from "react";
import { motionDefaults, motionTime, reducedMotion } from "../shared/motion/curves";
import { ChevronRightIcon, FolderIcon, UserIcon } from "@heroicons/react/24/outline";
import { EllipsisHorizontalIcon, PencilIcon, PeopleIcon } from "../shared/ui/ArchiveIcons";
import type { AlbumEntry, AssetSummary, AssetView, ClassificationEntry } from "../library/types";
import { useLibrary } from "../library/LibraryContext";
import { commandErrorMessage } from "../library/errorMessage";
import { AssetGallery } from "../assets/AssetGallery";
import { AssetViewer } from "../assets/AssetViewer";
import { AssetInspector } from "../assets/AssetInspector";
import { GalleryViewMenu } from "../assets/GalleryViewMenu";
import { libraryContextItems } from "../assets/libraryContextItems";
import { thumbnailUrl } from "../assets/mediaUrl";
import { applySelectionGesture, emptySelection, moveSelectionFocus, selectAllLoaded } from "../assets/selection";
import { Button } from "../shared/ui/Button";
import { Menu } from "../shared/ui/Menu";
import { Dialog } from "../shared/ui/Dialog";
import { Toast } from "../shared/ui/Toast";
import { useAutoDismiss } from "../shared/ui/useAutoDismiss";
import { ContextMenu, type ContextMenuItem } from "../shared/ui/ContextMenu";
import { AnchoredPanel } from "../shared/ui/AnchoredPanel";
import { useBackHandler } from "../shared/navigation/BackNavigation";
import { ViewToolbar } from "../layout/ViewToolbar";
import { collectPages, faultAssets, faultSelectionItem, useFaultGame, type FaultScope } from "../games/FaultGame";
import { CharacterRegistry, characterDraft, updateCharacterReferences, activeCharacterReferences, MAX_CHARACTER_REFERENCES, type CharacterEditorDraft } from "./CharacterRegistry";
import { CharacterConversion } from "./CharacterConversion";
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
import { characterHubApi, type CharacterBrowsePage, type CharacterGroup, type CharacterHubApi, type CharacterSeries, type SeriesGalleryFilter, type SeriesFolder } from "./hubApi";
import "./CharacterManagement.css";
import "./SeriesBrowser.css";

export type CharacterGalleryDrag = Pick<ComponentProps<typeof AssetGallery>, "onPointerDragStart" | "onPointerDragMove" | "onPointerDragEnd" | "onPointerDragCancel">;
type Props = {
  requestedAsset?: AssetSummary | null; onRequestedAssetHandled?: () => void;
  clearSelectionRequest?: number; galleryDrag?: CharacterGalleryDrag; albums?: AlbumEntry[];
  folderExclusions?: string[];
  series: CharacterSeries; targetId?: string; groupId?: string; targets: CharacterTarget[]; groups?: CharacterGroup[]; classifications: ClassificationEntry[];
  galleryLayout: "masonry" | "justified"; onGalleryLayoutChange: (layout: "masonry" | "justified") => void;
  privacyMode: boolean; onPrivacyModeChange: (value: boolean) => void;
  metadataVisible: boolean; onMetadataVisibleChange: (value: boolean) => void;
  thumbnailRowHeight: number; onThumbnailRowHeightChange: (value: number) => void; refreshVersion: number;
  onNavigate: (view: AssetView) => void; onChanged: () => void;
  api?: CharacterApi; hubApi?: CharacterHubApi; shadowApi?: ShadowReviewApi;
};
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
/** Status that used to sit under each character card; tiles now show only a warning mark when something is wrong. */
function characterStatus(target: CharacterTarget, readiness: S36Readiness | undefined, s36Driven: boolean): { detail: string[]; warning: boolean } {
  const references = activeCharacterReferences(target).length;
  const detail = !target.enabled ? ["자동 분석 꺼짐"] : references < 6 ? [`레퍼런스 ${references}장 · 자동 확정 보류`] : [];
  const s36 = target.enabled && !s36Driven ? readiness : undefined;
  if (s36) detail.push(readinessLabel(s36));
  return { detail, warning: Boolean(s36 && (s36.wrong > 0 || s36.status === "keep")) };
}

export function SeriesBrowser({ requestedAsset, onRequestedAssetHandled, clearSelectionRequest = 0, galleryDrag, albums = [], folderExclusions = [], series, targetId, groupId, targets, groups = [], classifications, galleryLayout, onGalleryLayoutChange, privacyMode, onPrivacyModeChange, metadataVisible, onMetadataVisibleChange, thumbnailRowHeight, onThumbnailRowHeightChange, refreshVersion, onNavigate, onChanged, api = characterApi, hubApi = characterHubApi, shadowApi = shadowReviewApi }: Props) {
  void onPrivacyModeChange;
  void onMetadataVisibleChange;
  const { gateway, library } = useLibrary();
  const previewCache = folderPreviewCache(gateway, library?.root);
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
  const galleryRefreshVersion = useCoalescedRefreshVersion(refreshVersion, loading);
  const [error, setError] = useState<string | null>(null), [editorError, setEditorError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [reload, setReload] = useState(0), [selection, setSelection] = useState(emptySelection);
  const [externalAsset, setExternalAsset] = useState<AssetSummary | null>(null), [viewer, setViewer] = useState<string | null>(null);
  const [editor, setEditor] = useState<Editor | null>(null);
  const [characterOpen, setCharacterOpen] = useState(false);
  const [pickFromSeries, setPickFromSeries] = useState(false);
  const [picking, setPicking] = useState<Picking | null>(null), [inspector, setInspector] = useState(false);
  const [converting, setConverting] = useState(false);
  const [referenceSuggestionTarget, setReferenceSuggestionTarget] = useState<CharacterTarget | null>(null);
  const [seriesGalleryState, setSeriesGalleryState] = useState<{ seriesId: string; view: SeriesGalleryView }>(() => ({ seriesId: series.classificationId, view: "unclassified" }));
  const [legacyExcludedCount, setLegacyExcludedCount] = useState(0);
  const [excludedLoading, setExcludedLoading] = useState(true);
  const [undo, setUndo] = useState<string[]>([]);
  const generation = useRef(0), pending = useRef(false), saving = useRef(false);
  const loadedScope = useRef<string | null>(null);
  // The scope the shown page belongs to. On a scope switch the previous images stay until the new
  // first page lands, instead of blanking the gallery (no-flash rule, DESIGN.md).
  const [pageScope, setPageScope] = useState<string | null>(null);
  const pickerPages = useRef(new Map<string, CharacterBrowsePage>());
  const returnGallery = useRef<{ scope: string; page: CharacterBrowsePage } | null>(null);
  useLayoutEffect(() => {
    setEditor(null); setPicking(null); setConverting(false); setViewer(null); setExternalAsset(null);
    setSelection(emptySelection()); setCharacterOpen(false); setShadowReview(false); setS36Setup(false);
    setReferenceSuggestionTarget(null); setAll(false); setUndo([]); setMessage(null); setEditorError(null);
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
  const members = targets.filter(t => t.seriesClassificationId === series.classificationId);
  // Per-character image counts come from the character index (character folders are hidden from the
  // folder tree, so their tree counts are missing); the folder tree is only a fallback.
  const [sidebarCounts, setSidebarCounts] = useState<Record<string, number> | null>(null);
  const [sidebarLoading, setSidebarLoading] = useState(Boolean(gateway.characterSidebarCounts));
  useEffect(() => {
    if (!gateway.characterSidebarCounts) { setSidebarLoading(false); return; }
    let active = true;
    setSidebarLoading(true);
    void gateway.characterSidebarCounts().then(result => { if (active) setSidebarCounts(result.targets); }, () => undefined)
      .finally(() => { if (active) setSidebarLoading(false); });
    return () => { active = false; };
  }, [gateway, refreshVersion, reload]);
  const characterCounts: Record<string, number> = Object.fromEntries(targets.flatMap(target => {
    const folder = target.linkedClassificationId ? classifications.find(entry => entry.id === target.linkedClassificationId) : undefined;
    const count = sidebarCounts?.[target.id] ?? folder?.totalAssetCount ?? folder?.assetCount;
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
  const scope = `${series.classificationId}:${picking ? picking.kind === "hero" ? "pick-hero" : `pick-${editor?.target?.id ?? "new"}-${pickFromSeries}` : targetId ? `character-${targetId}` : currentGroup ? `group-${currentGroup.id}` : `series-${seriesGalleryView}`}:${all}`;
  const ids = page.items.map(a => a.id);
  const selectedIds = [...selection.ids];
  const currentReferenceIds = new Set(current ? [
    ...current.references.flatMap(reference => reference.assetId ? [reference.assetId] : []),
    ...(current.learnedReferences?.flatMap(reference => reference.assetId ? [reference.assetId] : []) ?? []),
  ] : []);
  const selectedReferenceCount = selectedIds.filter(id => currentReferenceIds.has(id)).length;
  useAutoDismiss(message, setMessage);
  function refresh() { setReload(v => v + 1); onChanged(); }
  async function load(after: string | null = null) {
    if (after && pending.current) return;
    if (!after && pickerScope) {
      const cached = pickerPages.current.get(pickerScope);
      if (cached) { setPage(cached); setPageScope(scope); setLoading(false); setError(null); return; }
    }
    const token = after ? generation.current : ++generation.current;
    pending.current = true; setLoading(true); setError(null);
    try {
      const next = !picking && !targetId && !currentGroup && excludedOnly
        ? await hubApi.excludedAssets(series.classificationId, after, 100)
        : await hubApi.browse({ seriesId: series.classificationId,
        targetId: picking ? picking.kind !== "hero" && !pickFromSeries ? editor?.target?.id ?? null : null : targetId ?? null,
        groupId: picking ? null : currentGroup?.id ?? null,
        ...(picking && picking.kind !== "hero" ? { referenceTargetId: editor?.target?.id ?? "" } : {}),
        ...(!picking && !targetId && !currentGroup && !excludedOnly ? { seriesFilter: seriesGalleryView as SeriesGalleryFilter } : {}),
        all: !picking && !targetId && !currentGroup ? seriesGalleryView === "all" : all, after, limit: 100 });
      if (token === generation.current) setPage(old => {
        const value = after ? { ...next,
          items: [...old.items, ...next.items.filter(a => !old.items.some(b => b.id === a.id))],
          unavailableReferenceIds: [...new Set([...(old.unavailableReferenceIds ?? []), ...(next.unavailableReferenceIds ?? [])])],
        } : next;
        if (pickerScope) pickerPages.current.set(pickerScope, value);
        return value;
      });
      if (token === generation.current && !after) setPageScope(scope);
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
    void load(); return () => { ++generation.current; };
  }, [scope, galleryRefreshVersion, reload, hubApi]);
  useEffect(() => {
    if (targetId || currentGroup || picking) return;
    let active = true;
    setExcludedLoading(true);
    void hubApi.excludedAssets(series.classificationId, null, 1)
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
    void hubApi.seriesFolders(series.classificationId).then(result => {
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
    void shadowApi.page({ offset: 0, limit: 1, seriesId: series.classificationId })
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
  useEffect(() => {
    const openWithShortcut = (event: KeyboardEvent) => {
      if (event.key.toLowerCase() !== "c" || event.ctrlKey || event.metaKey || event.altKey || event.shiftKey || picking || selection.ids.size === 0) return;
      const target = event.target;
      if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || (target instanceof HTMLElement && target.isContentEditable)) return;
      event.preventDefault(); setCharacterOpen(true);
    };
    document.addEventListener("keydown", openWithShortcut);
    return () => document.removeEventListener("keydown", openWithShortcut);
  }, [picking, selection.ids.size]);
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
  async function assignCharacters(chosen: CharacterTarget[]) {
    if (!chosen.length || !selectedIds.length || saving.current) return;
    saving.current = true; setBusy(true); setError(null);
    try {
      const sameSeries = chosen.filter(target => target.seriesClassificationId === series.classificationId);
      const otherSeries = chosen.filter(target => target.seriesClassificationId !== series.classificationId);
      if (sameSeries.length) {
        // The decision batch takes at most 200 image × character pairs (kept from the old dialog).
        if (selectedIds.length * sameSeries.length > 200) throw new Error("이미지 수 × 캐릭터 수는 한 번에 200개까지 지정할 수 있습니다.");
        const available = await api.targets();
        const currentTargets = sameSeries.map(target => {
          const currentTarget = available.find(value => value.id === target.id && value.seriesClassificationId === series.classificationId);
          if (!currentTarget) throw new Error("캐릭터를 다시 선택해 주세요.");
          return currentTarget;
        });
        await api.decideBatch(currentTargets.map(target => ({ targetId: target.id, expectedFingerprint: target.fingerprint, assetIds: selectedIds, decision: "accepted" as const, baselineFingerprint: null, scanId: null })));
      }
      if (otherSeries.length) await moveAssetsToCharacters(otherSeries.map(target => ({ targetId: target.id, expectedFingerprint: target.fingerprint })), selectedIds);
      setCharacterOpen(false); setSelection(emptySelection()); refresh();
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
        ...(!targetId && !currentGroup ? { seriesFilter: seriesGalleryView as SeriesGalleryFilter, all: seriesGalleryView === "all" } : { all }), after, limit: 100 }), signal)
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
  </AnchoredPanel>;
  const contextItems: ContextMenuItem[] = picking ? [
    { id: "cancel-pick", label: "이미지 선택 취소", onSelect: () => finishPick(false) },
  ] : [
    ...libraryContextItems({ count: selectedIds.length, busy, albums,
      sourceUrls: page.items.filter(asset => selection.ids.has(asset.id)).map(asset => asset.sourceUrl), onMessage: setMessage,
      onAlbum: id => void action(() => gateway.patchAssetAlbums({ assetIds: selectedIds, addAlbumIds: [id], removeAlbumIds: [] })) }),
    ...faultSelectionItem(playFault, page.items.filter(asset => selection.ids.has(asset.id))),
    { id: "info", label: "정보 열기", disabled: !selectedIds.length, onSelect: () => setInspector(true) },
    { id: "refresh", label: "새로고침", onSelect: refresh },
    { id: "trash", label: "휴지통으로 이동", destructive: true, disabled: busy || !selectedIds.length, onSelect: () => void action(async () => { await gateway.trashAssets(selectedIds); setUndo(selectedIds); setSelection(emptySelection()); }) },
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
  const setSelectionFavorite = (favorite: boolean) => void action(() => gateway.setAssetsFavorite(selectedIds, favorite));
  const trashSelection = () => void action(async () => { await gateway.trashAssets(selectedIds); setUndo(selectedIds); setSelection(emptySelection()); });
  const characterExtraActions = current ? selectedReferenceCount > 0
    ? <Button size="sm" variant="ghost" disabled={busy} aria-description="선택에 참조 이미지가 포함되어 있습니다. 캐릭터 정보에서 먼저 해제하거나 교체해 주세요." onClick={() => openEditor(current)}>참조 설정 · {selectedReferenceCount.toLocaleString()}</Button>
    : <Button size="sm" variant="ghost" disabled={busy || selectedIds.length > 200} aria-description="한 번에 최대 200장" onClick={() => void action(async () => {
      await api.decide({ targetId: current.id, expectedFingerprint: current.fingerprint, assetIds: selectedIds, decision: "rejected", baselineFingerprint: null, scanId: null });
      setSelection(emptySelection());
    })}>이 캐릭터에서 제외</Button>
    : undefined;
  // The first page alone is not ready: the shelf and its count/header reads also change layout.
  const shelfLoading = !picking && !current && (sidebarLoading || (!currentGroup && (folderLoading || suggestions.loading || candidateLoading || excludedLoading || (!s36Settings && !s36Error))));
  return <section className="series-browser" aria-label={focusedName ?? name} aria-busy={loading || shelfLoading}>
    <ViewToolbar title={focusedName ? [name, current && currentCharacterGroup?.name, focusedName].filter(Boolean).join(" / ") : name} ariaLabel="시리즈 도구"
      titleContent={focusedName ? <span className="series-breadcrumb"><button onClick={() => onNavigate({ kind: "classification", classificationId: series.classificationId })}>{name}</button><ChevronRightIcon aria-hidden="true" />{current && currentCharacterGroup && <><button onClick={() => onNavigate({ kind: "classification", classificationId: series.classificationId, characterGroupId: currentCharacterGroup.id })}>{currentCharacterGroup.name}</button><ChevronRightIcon aria-hidden="true" /></>}<span>{focusedName}</span>{!current && <small className="series-header-count">{page.totalCount.toLocaleString()}장</small>}</span> : name}
      titleAccessory={<div className="series-header-actions">
        {!picking && (!currentGroup || editor) && editorPanel}
        {!picking && current && <Menu label="캐릭터 더보기" disabled={busy} trigger={<EllipsisHorizontalIcon aria-hidden="true" />} items={characterMenuItems} />}
        {!current && !currentGroup && !picking && <Menu label="시리즈 더보기" disabled={busy} trigger={<EllipsisHorizontalIcon aria-hidden="true" />} items={seriesMenuItems} />}
        {currentGroup && !picking && <Menu label="그룹 더보기" disabled={busy} trigger={<PeopleIcon aria-hidden="true" />} items={[
          { id: "edit-group", label: "그룹 편집", icon: <PencilIcon aria-hidden="true" />, onSelect: () => setGroupEditRequest(v => v + 1) },
          ...faultItem,
        ]} />}
        {!picking && <GalleryViewMenu galleryLayout={galleryLayout} onGalleryLayoutChange={onGalleryLayoutChange} thumbnailRowHeight={thumbnailRowHeight} onThumbnailRowHeightChange={onThumbnailRowHeightChange} inspectorOpen={inspector} inspectorAvailable={selectedIds.length > 0} onInspectorOpenChange={setInspector} />}
      </div>}
      chrome={{
        summary: `${galleryLayout === "masonry" ? "폭포수" : "같은 높이"} · ${thumbnailRowHeight}px${privacyMode ? " · 비공개" : ""}`,
        status: automationRecovery,
      }} actions={automationRecovery} />
    {picking && <div className="series-picking" role="region" aria-label="갤러리 이미지 선택">
      <div className="series-picking__title"><strong>{picking.kind === "references" ? `레퍼런스 선택 · ${picking.ids.length}/${MAX_CHARACTER_REFERENCES}` : picking.kind === "hero" ? "히어로 이미지 선택" : "대표 이미지 선택"}</strong><small>{picking.kind === "hero" ? name : editor?.target ? `${editor.target.displayName} 캐릭터 폴더 · 다른 캐릭터와 공유된 이미지는 제외됩니다` : "다른 캐릭터의 이미지는 제외됩니다"}</small></div>
      <div className="series-picking__chosen">{picking.ids.map((id,i) => <button key={id} aria-label={`선택 이미지 ${i + 1} 해제`} onClick={() => setPicking({ ...picking, ids: picking.ids.filter(v => v !== id) })}>{privacyMode ? <span className="privacy-mask" aria-label="비공개 모드"/> : <AssetImage src={thumbnailUrl(id)} alt="" />}<span>×</span></button>)}</div>
      <Button size="sm" disabled={busy || !picking.ids.length} onClick={() => finishPick(true)}>완료</Button><Button size="sm" variant="ghost" onClick={() => finishPick(false)}>취소</Button>
    </div>}
    <div className="series-browser__body">
    <ContextMenu items={contextItems}><div className="series-gallery" aria-busy={loading} inert={pageScope !== scope && page.items.length > 0 ? true : undefined} onContextMenu={event => {
      if (picking) return;
      const id = (event.target as HTMLElement).closest<HTMLElement>("[data-asset-id]")?.dataset.assetId;
      if (id && !selection.ids.has(id)) setSelection(old => applySelectionGesture(old, ids, id, { range: false, toggle: false }));
    }}>
      {!picking && !current && !currentGroup && excludedOnly && selection.ids.size > 0 && <div className="character-actions series-selection" role="region" aria-label="자동 분류 제외 이미지 선택">
        <span>{selection.ids.size}장 선택</span>
        <Button size="sm" disabled={busy || selectedIds.length > 200} onClick={() => void action(async () => {
          await hubApi.setSeriesAssetExcluded({ seriesId: series.classificationId, assetIds: selectedIds, excluded: false });
          setSelection(emptySelection());
        })}>분류 다시 시작</Button>
        <Button size="sm" variant="ghost" disabled={busy} onClick={() => setSelection(emptySelection())}>선택 해제</Button>
      </div>}
      <AssetGallery {...(!picking ? galleryDrag : {})} intro={<>
        {!picking && current && <div className="series-character-folder-head"><div className="folder-shelf__label character-group-heading"><span>이미지</span><span className="character-group-heading__count">{page.totalCount.toLocaleString("ko-KR")}</span></div></div>}
        {!picking && !current && !excludedOnly && <SeriesShelf scope={`${library?.root ?? ""}:${series.classificationId}:${currentGroup?.id ?? ""}`} privacyKey={String(privacyMode)} ready={!shelfLoading && (Boolean(currentGroup) || (!staleFolders && !folderLoading) || Boolean(folderError))}>
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
                <button disabled={staleFolders} className="series-character__open" aria-label={`${folder.name} 폴더 열기`} aria-description={excluded ? "캐릭터 분류 제외" : "일반 폴더"} onClick={() => onNavigate({ kind: "classification", classificationId: folder.id })}>
                  {privacyMode ? <span className="series-character__placeholder privacy-mask" aria-label="비공개 모드"/> : item.thumbnailAssetId ? <StableImage draggable={false} loading="lazy" src={thumbnailUrl(item.thumbnailAssetId)} alt="" /> : <span className="series-character__placeholder"><FolderIcon aria-hidden="true" />일반 폴더</span>}
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
                {privacyMode ? <span className="series-character__placeholder privacy-mask" aria-label="비공개 모드"/> : (target.thumbnailAssetId ?? activeCharacterReferences(target)[0]?.assetId) ? <StableImage draggable={false} loading="lazy" src={thumbnailUrl((target.thumbnailAssetId ?? activeCharacterReferences(target)[0]!.assetId)!)} alt="" /> : <span className="series-character__placeholder"><UserIcon aria-hidden="true" />대표 이미지</span>}
                <strong><UserIcon className="folder-shelf__icon" aria-hidden="true" />{status.warning && <span className="series-character__warning" aria-hidden="true">!</span>}<span className="series-character__name">{target.displayName}</span></strong>
                <small className="folder-shelf__meta" aria-hidden={memberCounts[target.id] === undefined || undefined}>{memberCounts[target.id] === undefined ? null : `${memberCounts[target.id]!.toLocaleString("ko-KR")}장`}</small>
              </button>
              <Button className="series-character__info" size="icon" variant="ghost" aria-label={`${target.displayName} 편집`} aria-description="캐릭터 편집" onClick={() => openEditor(target)}><PencilIcon aria-hidden="true" /></Button>
            </article></ContextMenu>;
            })}</>}</CharacterGroups>
        </SeriesShelf>}
        {!current && suggestions.error && <p role="alert">{suggestions.error}<Button size="sm" onClick={suggestions.refresh}>제안 다시 불러오기</Button></p>}
        {!current && suggestions.message && <p role="status">{suggestions.message}</p>}
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
        {!!undo.length && <div className="character-actions"><span>휴지통으로 이동했습니다.</span><Button size="sm" onClick={() => void action(async () => { await gateway.restoreAssets(undo); setUndo([]); })}>실행 취소</Button></div>}
        {!loading && !error && !page.items.length && <p className="series-gallery__empty">{picking ? "선택할 수 있는 이미지가 없습니다." : current ? "이 캐릭터의 이미지가 없습니다." : currentGroup ? "이 그룹에 연결된 이미지가 없습니다." : seriesGalleryView === "all" ? "이 시리즈에 이미지가 없습니다." : excludedOnly ? "자동 분류에서 제외한 이미지가 없습니다." : "미분류 이미지가 없습니다."}</p>}
      </>} layout={galleryLayout} groupDates items={page.items} scopeKey={pageScope ?? undefined} totalCount={page.totalCount} metadataVisible={metadataVisible} privacyMode={privacyMode} targetRowHeight={thumbnailRowHeight}
        captionLabel={picking && picking.kind !== "hero" ? asset => page.unavailableReferenceIds?.includes(asset.id) ? "원본 없음 · 선택 불가" : null : undefined}
        selectedAssetIds={picking ? new Set(picking.ids) : selection.ids} focusAssetId={picking ? null : selection.focusId}
        hasNextPage={Boolean(page.nextCursor) && !loading && !error && pageScope === scope} onLoadNextPage={() => void load(page.nextCursor)}
        onSelectionGesture={(a,gesture) => picking ? choose(a.id) : setSelection(old => applySelectionGesture(old, ids, a.id, gesture))}
        onSelectAll={picking ? undefined : () => setSelection(old => selectAllLoaded(old, ids))} onClearSelection={() => picking ? setPicking({ ...picking, ids: [] }) : setSelection(emptySelection())}
        onMoveFocus={picking ? undefined : (delta,extend) => setSelection(old => moveSelectionFocus(old, ids, delta, extend))} onOpen={a => picking ? choose(a.id) : setViewer(a.id)} />
      {!picking && ((current && selection.ids.size > 0) || (!current && !currentGroup && !excludedOnly && selection.ids.size > 0)) && <SelectionBar
        view={selectionView}
        selectedCount={selectedIds.length}
        batchPending={busy}
        characterOpen={characterOpen}
        onCharacterToggle={() => setCharacterOpen(open => !open)}
        characterPicker={<CharacterAssignPicker assetIds={selectedIds} targets={targets} groups={groups} classifications={classifications} counts={characterCounts} privacyMode={privacyMode} busy={busy}
          scopeSeriesId={series.classificationId} currentTargetId={current?.id} onCreate={!current && !currentGroup && !excludedOnly ? nameToCreate => createManualCharacter(nameToCreate) : undefined}
          onAssign={assignCharacters} onClose={() => setCharacterOpen(false)} />}
        extraActions={characterExtraActions}
        onFavorite={setSelectionFavorite}
        onTrash={trashSelection}
        onClearSelection={() => setSelection(emptySelection())}
      />}
    </div></ContextMenu>
    <SeriesInlineInspector assets={page.items.filter(a => selection.ids.has(a.id))} classifications={classifications} privacyMode={privacyMode} open={inspector} onOpenChange={setInspector} onOpenAsset={a => setViewer(a.id)} onOpenArtist={creatorKey => onNavigate({ kind: "creator", creatorKey })} onAssetUpdated={refresh} onAutoTagFilterApplied={() => onNavigate({ kind: "classification", classificationId: null })} />
    </div>
    {message && <Toast onDismiss={() => setMessage(null)}>{message}</Toast>}
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
    <AssetViewer items={externalAsset && !page.items.some(a => a.id === externalAsset.id) ? [externalAsset, ...page.items] : page.items} activeId={viewer} onActiveIdChange={setViewer} onClose={() => setViewer(null)} privacyMode={privacyMode} onAssetOpened={a => gateway.recordAssetOpened(a.id, new Date().toISOString())} onToggleFavorite={a => void action(() => gateway.setAssetFavorite(a.id, !a.favorite))} onTrash={a => void action(() => gateway.trashAssets([a.id]))} />
  </section>;
}

export function SeriesInlineInspector({ open, ...props }: ComponentProps<typeof AssetInspector>) {
  const [present, setPresent] = useState(open), [visible, setVisible] = useState(false);
  const panel = useRef<HTMLDivElement>(null), opener = useRef<HTMLElement | null>(null);
  const lastAssets = useRef(props.assets);
  if (open) lastAssets.current = props.assets;
  useLayoutEffect(() => {
    if (open) {
      opener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      setPresent(true);
      // Establish the closed pose once; subsequent toggles reverse the same transition.
      if (panel.current) void getComputedStyle(panel.current).opacity;
      const frame = requestAnimationFrame(() => setVisible(true));
      return () => cancelAnimationFrame(frame);
    }
    setVisible(false);
    if (panel.current?.contains(document.activeElement) && opener.current?.isConnected) opener.current.focus({ preventScroll: true });
    const duration = reducedMotion() ? motionTime("--motion-micro", motionDefaults.micro) : motionTime("--motion-medium", motionDefaults.medium) * .7;
    const timer = window.setTimeout(() => setPresent(false), duration);
    return () => window.clearTimeout(timer);
  }, [open]);
  return <div ref={panel} className="series-inspector-presence" data-open={open} data-visible={visible && open} aria-hidden={!open} inert={!open || undefined}>
    {(open || present) && <AssetInspector {...props} assets={open ? props.assets : lastAssets.current} open presentation="inline" />}
  </div>;
}
