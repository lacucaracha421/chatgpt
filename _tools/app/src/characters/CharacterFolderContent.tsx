import { EllipsisHorizontalIcon } from "@heroicons/react/24/outline";
import { CharacterFolderOrganizer } from "./CharacterFolderOrganizer";
import { FolderRegistrationContext } from "./FolderRegistrationContext";
import { useContext, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { CharacterFolderGroupDialog } from "./CharacterFolderGroupDialog";
import { folderGroupApi } from "./folderGroupApi";
import { AreaEntering, AreaVisible, AreaRequested, READY_CAP_MS, viewReady } from "../shared/motion/AreaSwitch";
import { revealTogether, waitForViewportImages } from "../shared/motion/viewportImages";
import { ChromeContext, useWorkspaceChrome, type Targets } from "../layout/WorkspaceChromeContext";
import type { AlbumEntry, AssetSort, AssetSummary, AssetView, ClassificationEntry } from "../library/types";
import { Menu } from "../shared/ui/Menu";
import { commandErrorMessage } from "../library/errorMessage";
import type { useCharacterHub } from "./useCharacterHub";
import { characterHubApi, type CharacterSeries } from "./hubApi";
import { SeriesBrowser, type CharacterGalleryDrag } from "./SeriesBrowser";
import { useOptionalLibrary } from "../library/LibraryContext";
import { seriesDataScope } from "./seriesMountCache";

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

export function CharacterFolderContent({ children, sort, onSortChange, requestedAsset, onRequestedAssetHandled, clearSelectionRequest, galleryDrag, view, hub, classifications, albums = [], galleryLayout, onGalleryLayoutChange, privacyMode, onPrivacyModeChange, metadataVisible, onMetadataVisibleChange, thumbnailRowHeight, onThumbnailRowHeightChange, refreshVersion, onNavigate, onAssetsChanged, onReviewVideos, onMembershipChanged, groupEditRequest, onGroupEditRequestHandled }: {
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
  /** The sidebar's 그룹 편집, handed to the series screen that owns the group editor. */
  groupEditRequest?: { groupId: string; token: number } | null; onGroupEditRequestHandled?: () => void;
}) {
  const [busy, setBusy] = useState(false), [error, setError] = useState<string | null>(null);
  const library = useOptionalLibrary();
  const cacheScope = seriesDataScope(library?.gateway, library?.library?.root);
  const [organizeCharacter, setOrganizeCharacter] = useState(false);
  const [organizeGroup, setOrganizeGroup] = useState(false);
  const [exclusions, setExclusions] = useState<{ key: string; ids: string[] } | null>(null);
  const id = view.kind === "classification" ? view.classificationId : null;
  const folder = classifications.find(item => item.id === id);
  const series = hub.series.find(s => s.classificationId === id);
  const originalScope = Boolean(id && inOriginals(id, classifications));
  const ancestors: string[] = [];
  let ancestor = folder;
  while (ancestor && !ancestors.includes(ancestor.id)) {
    ancestors.push(ancestor.id);
    ancestor = classifications.find(item => item.id === ancestor?.parentId);
  }
  const insideSeries = ancestors.slice(1).some(ancestorId => hub.series.some(entry => entry.classificationId === ancestorId));
  const groupEligible = Boolean(folder?.parentId && insideSeries && !series && !originalScope
    && !hub.targets.some(target => target.linkedClassificationId === id));
  const exclusionKey = JSON.stringify([id, refreshVersion, hub.revision]);
  useEffect(() => {
    if (!groupEligible) return;
    let active = true;
    void folderGroupApi.folderExclusions().then(ids => { if (active) setExclusions({ key: exclusionKey, ids }); },
      reason => { if (active) setError(commandErrorMessage(reason, "폴더의 분류 제외 상태를 확인하지 못했습니다.")); });
    return () => { active = false; };
  }, [groupEligible, exclusionKey]);
  const canOrganizeGroup = groupEligible && exclusions?.key === exclusionKey
    && !ancestors.some(ancestorId => exclusions.ids.includes(ancestorId));
  if (series && !originalScope) return <><FolderKindSwitch kind="series" cacheScope={cacheScope} seriesKey={JSON.stringify([id, view.kind === "classification" ? view.characterId : null, view.kind === "classification" ? view.characterGroupId : null])}><SeriesBrowser sort={sort} onSortChange={onSortChange} requestedAsset={requestedAsset} onRequestedAssetHandled={onRequestedAssetHandled} clearSelectionRequest={clearSelectionRequest} galleryDrag={galleryDrag} series={series} targetId={view.kind === "classification" ? view.characterId : undefined} groupId={view.kind === "classification" ? view.characterGroupId : undefined} targets={hub.targets} extras={hub.extras} groups={hub.groups} classifications={classifications} albums={albums} galleryLayout={galleryLayout} onGalleryLayoutChange={onGalleryLayoutChange} privacyMode={privacyMode} onPrivacyModeChange={onPrivacyModeChange} metadataVisible={metadataVisible} onMetadataVisibleChange={onMetadataVisibleChange} thumbnailRowHeight={thumbnailRowHeight} onThumbnailRowHeightChange={onThumbnailRowHeightChange} refreshVersion={refreshVersion + hub.revision} seriesRevisions={hub.seriesRevisions} onNavigate={onNavigate} onChanged={hub.refresh} onReviewVideos={onReviewVideos} onMembershipChanged={onMembershipChanged} groupEditRequest={groupEditRequest} onGroupEditRequestHandled={onGroupEditRequestHandled} onReorderGroups={hub.reorderGroups} onReorderCharacters={hub.reorderCharacters} /></FolderKindSwitch></>;
  async function register() {
    if (!id || busy) return;
    setBusy(true); setError(null);
    try { await characterHubApi.saveSeries({ classificationId: id, heroAssetId: null, autoClassify: true }); hub.refresh(); }
    catch (e) { setError(commandErrorMessage(e, "시리즈를 등록하지 못했습니다.")); }
    finally { setBusy(false); }
  }
  return <><FolderKindSwitch kind="plain" cacheScope={cacheScope}><FolderRegistrationContext.Provider value={folder?.parentId && !originalScope ? <Menu label="폴더 더보기" disabled={busy} trigger={<EllipsisHorizontalIcon aria-hidden="true" />} items={[
    { id: "register-series", label: "시리즈로 등록", onSelect: () => void register() },
    { id: "make-character", label: "캐릭터로 만들기", onSelect: () => setOrganizeCharacter(true) },
    ...(canOrganizeGroup ? [{ id: "organize-group", label: "그룹으로 정리", onSelect: () => setOrganizeGroup(true) }] : []),
  ]} /> : null}>
    <div className="character-folder-content">{(error || hub.error) && <p className="character-message" role="alert">{error || hub.error}</p>}{children}{organizeCharacter && id && <CharacterFolderOrganizer key={id} folderId={id} classifications={classifications} targets={hub.targets} privacyMode={privacyMode} onClose={() => setOrganizeCharacter(false)} onSingleSaved={target => { setOrganizeCharacter(false); onAssetsChanged(); onNavigate({ kind: "classification", classificationId: target.seriesClassificationId!, characterId: target.id }); }} />}
    </div>
  </FolderRegistrationContext.Provider></FolderKindSwitch>
      {/* Keep the dialog outside the retained browser so it closes as soon as apply succeeds. */}
      {organizeGroup && id && <CharacterFolderGroupDialog key={id} folderId={id} onClose={() => setOrganizeGroup(false)} onSaved={result => {
        setOrganizeGroup(false);
        // The series is already in the hub; FolderKindSwitch keeps this folder painted until it is ready.
        onNavigate({ kind: "classification", classificationId: result.seriesId });
        hub.refresh(); onAssetsChanged();
      }} />}
  </>;
}

type FolderKind = "series" | "plain";
const RETAINED_SERIES_LIMIT = 16;
export const FOLDER_SWITCH_HARD_CAP_MS = READY_CAP_MS * 5;

/**
 * A series folder and a plain folder open in different browsers. Visited series views keep their
 * real gallery and shelf trees mounted, within the cache limit. The painted browser stays, inert, while the new one prepares
 * out of sight: no chrome in the shell and no first-load entrance. Once its first screen is ready
 * (its data, shelf reads and the images in view decoded, within READY_CAP_MS) the two swap in one
 * step; first-screen images still loading at the cap then appear together, not one by one.
 * A longer hard cap releases the old inert browser even if data or measurement never finishes.
 */
export function FolderKindSwitch({ kind, children, seriesKey = "", cacheScope = "" }: { kind: FolderKind; children: ReactNode; seriesKey?: string; cacheScope?: string }) {
  const active = JSON.stringify([cacheScope, kind, kind === "series" ? seriesKey : ""]);
  const [shown, setShown] = useState(active);
  const browsers = useRef(new Map<string, { kind: FolderKind; children: ReactNode; scope: string }>());
  // Cache the real trees, not just their data: re-entry reuses decoded image DOM slots.
  // Outgoing props stay frozen until publication; offstage browsers never own the shell.
  browsers.current.set(active, { kind, children, scope: cacheScope });
  for (const [key, browser] of browsers.current) {
    if (key !== active && key !== shown && (browser.kind === "plain" || browser.scope !== cacheScope)) browsers.current.delete(key);
  }
  const seriesKeys = [...browsers.current].filter(([, browser]) => browser.kind === "series").map(([key]) => key);
  const evictable = seriesKeys.filter(key => key !== active && key !== shown);
  for (let excess = seriesKeys.length - RETAINED_SERIES_LIMIT; excess > 0 && evictable.length; excess--) browsers.current.delete(evictable.shift()!);
  const entering = useContext(AreaEntering);
  const areaVisible = useContext(AreaVisible);
  const areaRequested = useContext(AreaRequested);
  // A browser mounted by a switch never starts a first-load entrance of its own.
  const switched = useRef(new Set<string>());
  if (active !== shown) switched.current.add(active);
  for (const key of switched.current) if (!browsers.current.has(key)) switched.current.delete(key);
  const chrome = useWorkspaceChrome();
  // Shell slots for the preparing browser: detached, so its layout matches the final one without
  // reaching the shell, which keeps the painted browser's chrome until the swap.
  const [offstage] = useState<Targets>(() => {
    const slot = () => document.createElement("div");
    return { navigation: slot(), actions: slot(), search: slot(), settings: slot(), header: slot(), details: slot() };
  });
  const hosts = useRef(new Map<string, HTMLDivElement>());
  const check = useRef<(() => void) | null>(null);
  useLayoutEffect(() => {
    if (active === shown) return;
    const host = hosts.current.get(active);
    if (!host) return;
    const started = performance.now();
    let done = false, frame = 0, stopImages: (() => void) | undefined;
    const stop = () => {
      done = true; check.current = null;
      observer.disconnect(); window.clearTimeout(cap); window.clearTimeout(hardCap); window.cancelAnimationFrame(frame); stopImages?.();
    };
    const commit = () => { if (!done) { stop(); setShown(active); } };
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
    // The cap bounds image decoding, not first-page data. Publishing an unfinished
    // browser here would replace the painted screen with its empty initial render.
    const cap = window.setTimeout(ready, READY_CAP_MS);
    // Keep this independent of readiness and rAF: failed reads, zero-size hosts
    // and suspended frames must never strand the outgoing inert screen.
    const hardCap = window.setTimeout(commit, FOLDER_SWITCH_HARD_CAP_MS);
    check.current = ready;
    ready();
    return stop;
  }, [active, shown]);
  // Readiness may change without a DOM mutation (e.g. an empty first page).
  useLayoutEffect(() => { check.current?.(); });
  return <>{[...browsers.current].map(([key, browser]) => {
    const preparing = key === active && key !== shown;
    const hidden = key !== active && key !== shown;
    return <div key={key} className="folder-kind-switch" data-preparing={preparing || undefined}
      // Opacity hides the subtree even where a descendant sets visibility; images loading here take no fade.
      data-motion-view={preparing ? "folder-kind" : undefined} style={hidden ? { display: "none" } : preparing ? { opacity: 0, visibility: "hidden" } : undefined}
      inert={key !== active || preparing || undefined} aria-hidden={hidden || preparing || undefined}
      ref={element => { if (element) hosts.current.set(key, element); else hosts.current.delete(key); }}>
      <ChromeContext.Provider value={(preparing || hidden) && chrome ? { ...chrome, scope: `${chrome.scope}:preparing`, targets: offstage } : chrome}>
        <AreaVisible.Provider value={areaVisible && !hidden}>
          <AreaRequested.Provider value={areaRequested && key === active}>
            <AreaEntering.Provider value={entering || switched.current.has(key)}>{browser.children}</AreaEntering.Provider>
          </AreaRequested.Provider>
        </AreaVisible.Provider>
      </ChromeContext.Provider>
    </div>;
  })}</>;
}
