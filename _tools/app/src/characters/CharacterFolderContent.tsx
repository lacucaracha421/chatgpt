import { EllipsisHorizontalIcon } from "@heroicons/react/24/outline";
import { CharacterFolderOrganizer } from "./CharacterFolderOrganizer";
import { folderExclusionItem } from "./folderExclusion";
import { FolderRegistrationContext } from "./FolderRegistrationContext";
import { useContext, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { AreaEntering, READY_CAP_MS, viewReady } from "../shared/motion/AreaSwitch";
import { revealTogether, waitForViewportImages } from "../shared/motion/viewportImages";
import { ChromeContext, useWorkspaceChrome, type Targets } from "../layout/WorkspaceChromeContext";
import type { AlbumEntry, AssetSort, AssetSummary, AssetView, ClassificationEntry } from "../library/types";
import { Menu } from "../shared/ui/Menu";
import { commandErrorMessage } from "../library/errorMessage";
import type { useCharacterHub } from "./useCharacterHub";
import { characterHubApi, type CharacterSeries } from "./hubApi";
import { SeriesBrowser, type CharacterGalleryDrag } from "./SeriesBrowser";

function inOriginals(id: string, classifications: ClassificationEntry[]) {
  let current = classifications.find(item => item.id === id);
  const seen = new Set<string>();
  while (current && !seen.has(current.id)) {
    seen.add(current.id);
    if (!current.parentId) return current.id === "lakomics-originals" || current.name === "오리지널";
    current = classifications.find(item => item.id === current?.parentId);
  }
  return false;
}
/** Whether this folder opens as a series (SeriesBrowser) rather than a plain folder. */
export function opensAsSeries(id: string, series: CharacterSeries[], classifications: ClassificationEntry[]) {
  return series.some(entry => entry.classificationId === id) && !inOriginals(id, classifications);
}

export function CharacterFolderContent({ children, sort, onSortChange, requestedAsset, onRequestedAssetHandled, clearSelectionRequest, galleryDrag, view, hub, classifications, albums = [], galleryLayout, onGalleryLayoutChange, privacyMode, onPrivacyModeChange, metadataVisible, onMetadataVisibleChange, thumbnailRowHeight, onThumbnailRowHeightChange, refreshVersion, onNavigate, onAssetsChanged, onReviewVideos, onMembershipChanged }: {
  requestedAsset?: AssetSummary | null; onRequestedAssetHandled?: () => void;
  clearSelectionRequest?: number; galleryDrag?: CharacterGalleryDrag;
  /** The asset sort shared with plain folders (App preferences); series, groups and characters use it too. */
  sort?: AssetSort; onSortChange?: (sort: AssetSort) => void;
  children: ReactNode; view: AssetView; hub: ReturnType<typeof useCharacterHub>; classifications: ClassificationEntry[]; albums?: AlbumEntry[];
  galleryLayout: "masonry" | "justified"; onGalleryLayoutChange: (layout: "masonry" | "justified") => void;
  privacyMode: boolean; onPrivacyModeChange: (value: boolean) => void;
  metadataVisible: boolean; onMetadataVisibleChange: (value: boolean) => void;
  thumbnailRowHeight: number; onThumbnailRowHeightChange: (value: number) => void;
  refreshVersion: number; onNavigate: (view: AssetView) => void; onAssetsChanged: () => void;
  /** Passed to series folders as plain folders get them: 선택한 영상 비교 and the counts after an asset edit. */
  onReviewVideos?: (assetIds: string[]) => void; onMembershipChanged?: () => void;
}) {
  const [busy, setBusy] = useState(false), [error, setError] = useState<string | null>(null);
  const [organizeCharacter, setOrganizeCharacter] = useState(false);
  const id = view.kind === "classification" ? view.classificationId : null;
  const folder = classifications.find(item => item.id === id);
  const series = hub.series.find(s => s.classificationId === id);
  const originalScope = Boolean(id && inOriginals(id, classifications));
  const folderExclusions = hub.folderExclusions ?? [];
  const seriesAncestor = (() => {
    let current = folder;
    const seen = new Set<string>();
    while (current?.parentId && !seen.has(current.id)) {
      seen.add(current.id);
      const parentId = current.parentId;
      if (hub.series.some(series => series.classificationId === parentId)) return true;
      current = classifications.find(folder => folder.id === parentId);
    }
    return false;
  })();
  async function setExcluded(excluded: boolean) {
    if (!id || busy) return;
    setBusy(true); setError(null);
    try { await characterHubApi.setFolderExcluded(id, excluded); hub.refresh(); onAssetsChanged(); }
    catch (error) { setError(commandErrorMessage(error, "폴더의 분류 설정을 저장하지 못했습니다.")); }
    finally { setBusy(false); }
  }
  if (series && !originalScope) return <FolderKindSwitch kind="series"><SeriesBrowser sort={sort} onSortChange={onSortChange} requestedAsset={requestedAsset} onRequestedAssetHandled={onRequestedAssetHandled} clearSelectionRequest={clearSelectionRequest} galleryDrag={galleryDrag} folderExclusions={folderExclusions} series={series} targetId={view.kind === "classification" ? view.characterId : undefined} groupId={view.kind === "classification" ? view.characterGroupId : undefined} targets={hub.targets} groups={hub.groups} classifications={classifications} albums={albums} galleryLayout={galleryLayout} onGalleryLayoutChange={onGalleryLayoutChange} privacyMode={privacyMode} onPrivacyModeChange={onPrivacyModeChange} metadataVisible={metadataVisible} onMetadataVisibleChange={onMetadataVisibleChange} thumbnailRowHeight={thumbnailRowHeight} onThumbnailRowHeightChange={onThumbnailRowHeightChange} refreshVersion={refreshVersion + hub.revision} seriesRevisions={hub.seriesRevisions} onNavigate={onNavigate} onChanged={hub.refresh} onReviewVideos={onReviewVideos} onMembershipChanged={onMembershipChanged} /></FolderKindSwitch>;
  async function register() {
    if (!id || busy) return;
    setBusy(true); setError(null);
    try { await characterHubApi.saveSeries({ classificationId: id, heroAssetId: null, autoClassify: true }); hub.refresh(); }
    catch (e) { setError(commandErrorMessage(e, "시리즈를 등록하지 못했습니다.")); }
    finally { setBusy(false); }
  }
  return <FolderKindSwitch kind="plain"><FolderRegistrationContext.Provider value={folder?.parentId && !originalScope ? <Menu label="폴더 더보기" disabled={busy} trigger={<EllipsisHorizontalIcon aria-hidden="true" />} items={[
    ...((seriesAncestor && !hub.targets.some(target => target.linkedClassificationId === id)) || folderExclusions.includes(id!) ? [folderExclusionItem(id!, classifications, folderExclusions, excluded => void setExcluded(excluded))] : []),
    { id: "register-series", label: "시리즈로 등록", onSelect: () => void register() },
    { id: "make-character", label: "캐릭터로 만들기", onSelect: () => setOrganizeCharacter(true) },
  ]} /> : null}>
    <div className="character-folder-content">{(error || hub.error) && <p className="character-message" role="alert">{error || hub.error}</p>}{children}{organizeCharacter && id && <CharacterFolderOrganizer key={id} folderId={id} classifications={classifications} targets={hub.targets} privacyMode={privacyMode} onClose={() => setOrganizeCharacter(false)} onSingleSaved={target => { setOrganizeCharacter(false); onAssetsChanged(); onNavigate({ kind: "classification", classificationId: target.seriesClassificationId!, characterId: target.id }); }} />}</div>
  </FolderRegistrationContext.Provider></FolderKindSwitch>;
}

type FolderKind = "series" | "plain";
const FOLDER_KINDS: readonly FolderKind[] = ["series", "plain"];

/**
 * A series folder and a plain folder open in different browsers, so moving between them mounts the
 * other one (no-flash rule, DESIGN.md). The painted browser stays, inert, while the new one prepares
 * out of sight: no chrome in the shell and no first-load entrance. Once its first screen is ready
 * (its data, shelf reads and the images in view decoded, within READY_CAP_MS) the two swap in one
 * step; first-screen images still loading at the cap then appear together, not one by one.
 */
export function FolderKindSwitch({ kind, children }: { kind: FolderKind; children: ReactNode }) {
  const [shown, setShown] = useState(kind);
  const painted = useRef(children);
  if (kind === shown) painted.current = children;
  const entering = useContext(AreaEntering);
  // A browser mounted by a switch never starts a first-load entrance of its own.
  const switched = useRef(new Set<FolderKind>());
  if (kind !== shown) switched.current.add(kind);
  for (const key of FOLDER_KINDS) if (key !== kind && key !== shown) switched.current.delete(key);
  const chrome = useWorkspaceChrome();
  // Shell slots for the preparing browser: detached, so its layout matches the final one without
  // reaching the shell, which keeps the painted browser's chrome until the swap.
  const [offstage] = useState<Targets>(() => {
    const slot = () => document.createElement("div");
    return { navigation: slot(), actions: slot(), search: slot(), settings: slot(), header: slot(), details: slot() };
  });
  const hosts = useRef(new Map<FolderKind, HTMLDivElement>());
  const check = useRef<(() => void) | null>(null);
  useLayoutEffect(() => {
    if (kind === shown) return;
    const host = hosts.current.get(kind);
    if (!host) return;
    const started = performance.now();
    let done = false, frame = 0, stopImages: (() => void) | undefined;
    const stop = () => {
      done = true; check.current = null;
      observer.disconnect(); window.clearTimeout(cap); window.cancelAnimationFrame(frame); stopImages?.();
    };
    const commit = () => { if (!done) { stop(); setShown(kind); } };
    const ready = () => {
      if (done || frame || stopImages || !viewReady(host)) return;
      // The gallery measures its first viewport before the batch is chosen.
      frame = window.requestAnimationFrame(() => {
        frame = 0;
        if (done || !viewReady(host)) return;
        observer.disconnect(); window.clearTimeout(cap);
        stopImages = waitForViewportImages(host, commit, Math.max(0, READY_CAP_MS - (performance.now() - started)),
          late => void revealTogether(late, READY_CAP_MS));
      });
    };
    const observer = new MutationObserver(ready);
    observer.observe(host, { subtree: true, childList: true, attributes: true });
    // Never leave an inert old browser up: its data cap shows the new one as it is.
    const cap = window.setTimeout(commit, READY_CAP_MS);
    check.current = ready;
    ready();
    return stop;
  }, [kind, shown]);
  // Readiness may change without a DOM mutation (e.g. an empty first page).
  useLayoutEffect(() => { check.current?.(); });
  return <>{FOLDER_KINDS.filter(key => key === kind || key === shown).map(key => {
    const preparing = key === kind && key !== shown;
    return <div key={key} className="folder-kind-switch" data-preparing={preparing || undefined}
      // Opacity hides the subtree even where a descendant sets visibility; images loading here take no fade.
      data-motion-view={preparing ? "folder-kind" : undefined} style={preparing ? { opacity: 0, visibility: "hidden" } : undefined}
      inert={key !== kind || preparing || undefined} aria-hidden={preparing || undefined}
      ref={element => { if (element) hosts.current.set(key, element); else hosts.current.delete(key); }}>
      <ChromeContext.Provider value={preparing && chrome ? { ...chrome, scope: `${chrome.scope}:preparing`, targets: offstage } : chrome}>
        <AreaEntering.Provider value={entering || switched.current.has(key)}>{key === kind ? children : painted.current}</AreaEntering.Provider>
      </ChromeContext.Provider>
    </div>;
  })}</>;
}
