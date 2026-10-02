import { ChevronDownIcon, ChevronLeftIcon, MagnifyingGlassIcon, EllipsisHorizontalIcon, PlusIcon, StarIcon, CalendarIcon, BellIcon } from "@heroicons/react/24/outline";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { collectionSourceThumbnailUrl, thumbnailUrl, workArtworkThumbnailUrl } from "../assets/mediaUrl";
import { useLibrary } from "../library/LibraryContext";
import { commandErrorMessage } from "../library/errorMessage";
import type { AssetView, CollectionSummary, CollectionType, CollectionUpdateProvider, CollectionVolumeRangeInput, CreateCollection, UpdateCollection } from "../library/types";
import type { ViewChromeSpec } from "../layout/WorkspaceChrome";
import { ViewToolbar } from "../layout/ViewToolbar";
import { useInWorkspaceChrome } from "../layout/WorkspaceChromeContext";
import { Scrubber } from "../shared/ui/scrubber/Scrubber";
import type { ScrubberSort } from "../shared/ui/scrubber/scrubberModel";
import { useScrubberList } from "../shared/ui/scrubber/useScrubberList";
import { Button } from "../shared/ui/Button";
import { ViewOptionsMenu } from "../shared/ui/ViewOptionsMenu";
import { useLaunchBoxSpineBatch } from "./launchBoxSpines";
import { CollectionList, shelfGroups, useCollectionView } from "./CollectionList";
import { useShelfPutDown } from "./useShelfPutDown";
import { MangaShelfList } from "./MangaShelfList";
import type { MangaShelfPick } from "./MangaShelfRow";
import { requestMangaVolume } from "./work/mangaVolumeRequest";
import { TextInput } from "../shared/ui/TextInput";
import { Slider } from "../shared/ui/Slider";
import { ContextMenu } from "../shared/ui/ContextMenu";
import { Dialog } from "../shared/ui/Dialog";
import { EmptyState } from "../shared/ui/EmptyState";
import { Menu } from "../shared/ui/Menu";
import { SectionDropMount, useSectionDrop } from "../shared/ui/useSectionDrop";
import { Toast } from "../shared/ui/Toast";
import { useAutoDismiss } from "../shared/ui/useAutoDismiss";
import { useCollectionCoverPerf } from "./collectionPerf";
import { CollectionCard } from "./CollectionCard";
import { CollectionExhibition, exhibitionPage } from "./physical/CollectionExhibition";
import { CollectionEditDialog, type CollectionEditMode } from "./CollectionEditDialog";
import { MangaDexImportDialog } from "./MangaDexImportDialog";
import { IgdbImportDialog } from "./IgdbImportDialog";
import { TmdbMovieDialog } from "./TmdbMovieDialog";
import { CollectionReleases } from "./CollectionReleases";
import { ReleaseCalendarView } from "./ReleaseCalendarView";
import { groupInbox, localDay, releaseCaption } from "./releaseCaption";
import { useReleaseData } from "./releaseData";
import { deriveCollectionLibrary, type CollectionLibrarySort, type CollectionLibraryState } from "./collectionLibrary";
import { AvLinkInbox, useAvLinkInbox, type AvLinkApi } from "./AvLinkInbox";
import { KIND_LABEL } from "./collectionFormat";
import "./CollectionBrowser.css";
import "../styles/collectionSpines.css";

const TYPE_LABEL: Record<CollectionType, string> = KIND_LABEL;
const TYPES: CollectionType[] = ["game", "manga", "movie", "av"];
export type CollectionNavigationMemory = Map<string, { scrollTop: number; focusId: string | null; page?: number }>;

type CollectionBrowserProps = {
  /** The 신간 view: kakao = 한국 정발, mangadex = 일본. */
  releaseProvider?: CollectionUpdateProvider;
  /** The 발매 캘린더 (upcoming games and movies, and the 관심 목록). */
  releaseCalendar?: boolean;
  navigationMemory?: CollectionNavigationMemory;
  collections: CollectionSummary[];
  typeFilter: CollectionType;
  showcase: boolean;
  onViewChange: (next: AssetView) => void;
  onChanged: () => Promise<void>;
  onOpenWork?: (id: string, order: string[]) => void;
  libraryState: CollectionLibraryState;
  onLibraryStateChange: (next: CollectionLibraryState) => void;
  avLinkApi?: AvLinkApi;
};

/** The card cover: the chosen work artwork, else the media-vault cover asset, else the source preview. */
export function collectionCoverUrl(collection: CollectionSummary): string | null {
  return collection.selectedWorkArtworkId
    ? workArtworkThumbnailUrl(collection.selectedWorkArtworkId)
    : collection.coverAssetId
      ? thumbnailUrl(collection.coverAssetId)
      : collection.sourcePath
        ? collectionSourceThumbnailUrl(collection.id)
        : null;
}

/**
 * The Collections browser. The section bar under the top bar holds the types with sort, rating and
 * view controls at its right end and shortcuts in a second row. The list spans the workspace
 * beside the rail; shortcuts open the existing news views and paged Showcase exhibition.
 */
export function CollectionBrowser({
  releaseProvider,
  releaseCalendar = false,
  navigationMemory,
  collections,
  typeFilter,
  showcase,
  onViewChange,
  onChanged,
  onOpenWork,
  libraryState,
  onLibraryStateChange,
  avLinkApi,
}: CollectionBrowserProps) {
  const { gateway, library } = useLibrary();
  // Presence only: the chrome's published title changes with every type switch, and re-rendering the whole list for it cost a frame.
  const workspace = useInWorkspaceChrome();
  const spineBatch = useLaunchBoxSpineBatch(gateway, library?.root ?? "");
  useAutoDismiss(spineBatch.message, spineBatch.dismiss);
  const [viewSettings, patchViewSettings] = useCollectionView(typeFilter);
  const [pickedId, setPickedId] = useState<string | null>(null);
  const [mangaPick, setMangaPick] = useState<MangaShelfPick>(null);
  const [editMode, setEditMode] = useState<CollectionEditMode | null>(null);
  const [mangaDexOpen, setMangaDexOpen] = useState(false);
  const [igdbOpen, setIgdbOpen] = useState(false);
  const [tmdbOpen, setTmdbOpen] = useState(false);
  const avInbox = useAvLinkInbox({ api: avLinkApi, poll: typeFilter === "av" && !releaseProvider && !releaseCalendar && !showcase,
    refreshKey: `${typeFilter}:${releaseProvider ?? ""}:${releaseCalendar ? 1 : 0}:${showcase ? 1 : 0}` });

  const [deleteTarget, setDeleteTarget] = useState<CollectionSummary | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const tracking = gateway.collectionTracking;
  // Manga tiles and the 신간 view share one cached read of the release board and inbox.
  const releases = useReleaseData(tracking, collections, Boolean(tracking) && (typeFilter === "manga" || Boolean(releaseProvider)));
  const inboxByWork = useMemo(() => groupInbox(releases.data?.inbox ?? []), [releases.data]);
  const unreadTotal = collections.reduce((sum, collection) => sum + (collection.type === "manga" ? collection.unreadReleaseCount : 0), 0);
  const today = localDay();
  const openInbox = (provider: CollectionUpdateProvider) => onViewChange({ kind: "collections", typeFilter, showcase, releaseProvider: provider });
  const closeInbox = () => onViewChange({ kind: "collections", typeFilter, showcase });
  const calendarApi = gateway.releaseCalendar;
  const openCalendar = () => onViewChange({ kind: "collections", typeFilter, showcase: false, releaseCalendar: true });
  // Unread 관심 목록 events for the 발매 캘린더 row; re-read after the view changes the wishlist.
  const [wishlistUnread, setWishlistUnread] = useState(0);
  const loadWishlistUnread = useCallback(() => {
    if (!calendarApi) return;
    void calendarApi.wishlist().then(items => setWishlistUnread(items.reduce((sum, item) => sum + item.unread.length, 0)), () => undefined);
  }, [calendarApi]);
  useEffect(loadWishlistUnread, [loadWishlistUnread]);
  const libraryStateRef = useRef(libraryState);
  libraryStateRef.current = libraryState;
  useAutoDismiss(message, setMessage);
  const stageRef = useRef<HTMLDivElement>(null);
  const [pageMemory, setPageMemory] = useState<{ scope: string; page: number } | null>(null);
  const scope = JSON.stringify([library?.root ?? "", typeFilter, showcase, libraryState.query, libraryState.sort, libraryState.direction, libraryState.rating, releaseProvider, releaseCalendar]);
  useCollectionCoverPerf(stageRef, scope, collections);
  useLayoutEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;
    const remembered = navigationMemory?.get(scope);
    stage.scrollTop = remembered?.scrollTop ?? 0;
    let restoreFrame = 0;
    let observer: MutationObserver | null = null;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    if (remembered?.focusId) {
      const focus = () => {
        const card = [...stage.querySelectorAll<HTMLElement>("[data-collection-id]")].find(item => item.dataset.collectionId === remembered.focusId);
        if (!card) return;
        card.focus({ preventScroll: true }); observer?.disconnect(); clearTimeout(timeout);
      };
      // Virtual rows can arrive after their first measurement; do not poll forever.
      observer = new MutationObserver(focus); observer.observe(stage, { childList: true, subtree: true });
      timeout = setTimeout(() => observer?.disconnect(), 800);
      restoreFrame = requestAnimationFrame(() => { restoreFrame = requestAnimationFrame(focus); });
    }
    return () => { cancelAnimationFrame(restoreFrame); clearTimeout(timeout); observer?.disconnect(); navigationMemory?.set(scope, { ...navigationMemory.get(scope), scrollTop: stage.scrollTop, focusId: navigationMemory.get(scope)?.focusId ?? null }); };
  }, [scope, navigationMemory]);

  const showcaseItems = useMemo(() => collections.filter((collection) => collection.type === typeFilter && collection.showcase).sort((a, b) => (a.showcaseOrder ?? Number.MAX_SAFE_INTEGER) - (b.showcaseOrder ?? Number.MAX_SAFE_INTEGER) || a.name.localeCompare(b.name) || a.id.localeCompare(b.id)), [collections, typeFilter]);
  const libraryItems = useMemo(() => deriveCollectionLibrary(collections, typeFilter, libraryState), [collections, typeFilter, libraryState]);
  const visible = useMemo(() => showcase ? showcaseItems : viewSettings.layout === "shelf" && typeFilter === "game" ? shelfGroups(libraryItems, viewSettings.grouping).flatMap(group => group.items) : libraryItems, [showcase, showcaseItems, viewSettings.layout, viewSettings.grouping, typeFilter, libraryItems]);
  const filtered = Boolean(libraryState.query.trim()) || libraryState.rating !== "all";
  const sectionLabel = TYPE_LABEL[typeFilter];
  const exhibition = exhibitionPage(visible.length, pageMemory?.scope === scope ? pageMemory.page : navigationMemory?.get(scope)?.page ?? 0);
  function changeExhibitionPage(page: number) {
    setPageMemory({ scope, page });
    navigationMemory?.set(scope, { scrollTop: 0, focusId: null, page });
  }

  function setTypeFilter(next: CollectionType) {
    if (next === typeFilter && !releaseProvider && !releaseCalendar && !showcase) return;
    onViewChange({ kind: "collections", typeFilter: next, showcase: false });
  }

  function setShowcase(next: boolean) {
    onViewChange({ kind: "collections", typeFilter, showcase: next });
  }

  function patchLibraryState(update: Partial<CollectionLibraryState>) {
    const next = { ...libraryStateRef.current, ...update };
    libraryStateRef.current = next;
    onLibraryStateChange(next);
  }

  async function handleSubmit(input: CreateCollection | UpdateCollection, mediaType?: "movie" | "tv") {
    if (editMode?.kind === "create") {
      const created = await gateway.createCollection(input as CreateCollection);
      await onChanged();
      onViewChange({ kind: "collection", collectionId: created.id,
        ...(created.type === "movie" ? { tmdbSearch: { query: created.name, mediaType: mediaType ?? "movie" } } : {}),
      });
      return;
    } else if (editMode?.kind === "edit") {
      await gateway.updateCollection(editMode.collection.id, input as UpdateCollection);
    }
    await onChanged();
  }

  async function handleMangaSettings(input: CollectionVolumeRangeInput) {
    if (editMode?.kind !== "edit" || editMode.collection.type !== "manga") return;
    if (!gateway.setCollectionVolumeRange) return;
    await gateway.setCollectionVolumeRange(editMode.collection.id, input);
    await onChanged();
  }

  async function toggleShowcase(collection: CollectionSummary) {
    try {
      await gateway.setCollectionShowcase(collection.id, !collection.showcase);
      await onChanged();
    } catch (error) {
      setMessage(commandErrorMessage(error, "쇼케이스를 변경하지 못했습니다."));
    }
  }

  async function removeCollection() {
    if (!deleteTarget) return;
    try {
      await gateway.deleteCollection(deleteTarget.id);
      setDeleteTarget(null);
      await onChanged();
    } catch (error) {
      setMessage(commandErrorMessage(error, "컬렉션을 삭제하지 못했습니다."));
    }
  }

  const openCollection = (collection: CollectionSummary, order = visible) => {
    navigationMemory?.set(scope, { scrollTop: stageRef.current?.scrollTop ?? 0, focusId: collection.id, page: exhibition.page });
    if (onOpenWork && (collection.type === "game" || collection.type === "av" || collection.type === "movie")) onOpenWork(collection.id, order.map(item => item.id));
    else onViewChange({ kind: "collection", collectionId: collection.id });
  };

  // Cards call the latest handlers through this ref, so the list's render callback below changes only
  // with what the cards show. Re-rendering a few hundred cards for an unrelated browser update (the chrome
  // title on a type switch, the AV inbox, a toast) cost about a frame each.
  const latest = useRef({ openCollection, toggleShowcase });
  useLayoutEffect(() => { latest.current = { openCollection, toggleShowcase }; });
  const collectionMenu = useCallback((collection: CollectionSummary) => [
    { id: "edit", label: "편집", onSelect: () => setEditMode({ kind: "edit", collection }) },
    { id: "showcase", label: collection.showcase ? "쇼케이스에서 제거" : "쇼케이스에 추가", onSelect: () => void latest.current.toggleShowcase(collection) },
    { id: "delete", label: "삭제", destructive: true, onSelect: () => setDeleteTarget(collection) },
  ], []);
  // 책장 keeps the per-work volume rows; 선반 uses the shared work cases.
  const mangaBookcase = typeFilter === "manga" && viewSettings.layout === "bookcase";
  const openMangaAt = (collection: CollectionSummary, volumeId: string | null) => {
    if (volumeId) requestMangaVolume(collection.id, volumeId);
    openCollection(collection);
  };
  const mangaShelfList = (items: CollectionSummary[], label: string) => <MangaShelfList items={items} label={label} board={releases.data?.board}
    pick={mangaPick} onPick={setMangaPick} menu={collectionMenu} onOpen={openMangaAt} />;

  const libraryRoot = library?.root ?? "";
  const board = releases.data?.board;
  const viewLayout = viewSettings.layout;
  const renderCollection = useCallback((collection: CollectionSummary) => {
    const shelf = viewLayout === "shelf" && !showcase;
    const work = collection.type !== "manga" || shelf;
    const open = () => latest.current.openCollection(collection);
    return <ContextMenu
              key={collection.id}
              items={collectionMenu(collection)}
            >
              <CollectionCard
                collection={collection}
                coverUrl={collectionCoverUrl(collection)}
                selected={pickedId === collection.id}
                lightCase={!showcase}
                shelf={shelf}
                releaseCaption={releaseCaption(collection, board?.get(collection.id), inboxByWork.get(collection.id) ?? [], today)}
                scope={libraryRoot}
                exhibition={showcase}
                onClick={() => { if (work) setPickedId(collection.id); else latest.current.openCollection(collection); }}
                onDoubleClick={() => { if (work) open(); }}
                onKeyDown={event => { if (work && event.key === "Enter") { event.preventDefault(); open(); } }}
              />
            </ContextMenu>;
  }, [collectionMenu, pickedId, showcase, viewLayout, typeFilter, board, inboxByWork, today, libraryRoot]);

  const collectionActions = (
          <>
          <Menu
            label="새 컬렉션"
            trigger={<PlusIcon aria-hidden="true" />}
            items={[
              ...(typeFilter === "game" ? [{ id: "igdb", label: "IGDB에서 게임 추가", onSelect: () => setIgdbOpen(true) }] : []),
              ...(typeFilter === "manga" ? [{ id: "mangadex", label: "MangaDex에서 만화 추가", onSelect: () => setMangaDexOpen(true) }] : []),
              ...(typeFilter === "movie" ? [{ id: "tmdb", label: "TMDB에서 영화 추가", onSelect: () => setTmdbOpen(true) }] : []),
              { id: "manual", label: "직접 입력", onSelect: () => setEditMode({ kind: "create", type: typeFilter }) },
            ]}
          />
          </>
        );

  const inbox = Boolean(releaseProvider) || releaseCalendar;
  const libraryView = !inbox && !showcase;
  const shortcuts = <div className="ui-segmented ui-segmented--full-width collection-shortcuts" role="group" aria-label="컬렉션 바로가기">
    <button type="button" className="ui-segmented__cell" aria-label={`쇼케이스 ${showcaseItems.length.toLocaleString()}`} onClick={() => setShowcase(true)}>
      <StarIcon aria-hidden="true" />쇼케이스<span className="collection-shortcuts__count">{showcaseItems.length.toLocaleString()}</span>
    </button>
    {(typeFilter === "game" || typeFilter === "movie") && <button type="button" className="ui-segmented__cell"
      aria-label={wishlistUnread > 0 ? `발매 캘린더 보기, 관심 목록 새 알림 ${wishlistUnread.toLocaleString()}개` : "발매 캘린더 보기"} onClick={openCalendar}>
      <CalendarIcon aria-hidden="true" />발매 캘린더{wishlistUnread > 0 && <span className="collection-shortcuts__count is-new" aria-hidden="true">{wishlistUnread.toLocaleString()}</span>}
    </button>}
    {typeFilter === "manga" && <button type="button" className="ui-segmented__cell"
      aria-label={unreadTotal > 0 ? `신간 보기, 새 알림 ${unreadTotal.toLocaleString()}개` : "신간 보기"} onClick={() => openInbox("kakao")}>
      <BellIcon aria-hidden="true" />신간{unreadTotal > 0 && <span className="collection-shortcuts__count is-new" aria-hidden="true">{unreadTotal.toLocaleString()}</span>}
    </button>}
  </div>;
  const avCount = avInbox.items.length;
  const typeOptions = TYPES.map(value => value === "av" && avCount > 0
    ? { value, label: TYPE_LABEL[value], count: avCount, ariaLabel: `AV, 받은 품번 ${avCount.toLocaleString()}개` }
    : { value, label: TYPE_LABEL[value] });

  const sectionRow = <div className="collection-browser__section collection-browser__section--all">
    <h3>{filtered ? "검색 결과" : "전체"}<span className="collection-browser__total" aria-label={`작품 ${visible.length.toLocaleString()}개`}>{visible.length.toLocaleString()}</span></h3>
  </div>;
  const leading = <>{typeFilter === "av" && <AvLinkInbox items={avInbox.items} collections={collections} api={avLinkApi} error={avInbox.error}
    onRefresh={avInbox.refresh} onCollectionsChanged={onChanged} />}{sectionRow}</>;
  const emptyLibrary = filtered ? <EmptyState title="조건에 맞는 작품이 없습니다."><p>검색어나 별점 조건을 바꿔보세요.</p><Button onClick={() => patchLibraryState({ query: "", rating: "all" })}>검색·필터 초기화</Button></EmptyState>
    : <EmptyState title="컬렉션이 없습니다."><p>새 컬렉션을 만들어 작품을 모아보세요.</p><Button type="button" onClick={() => typeFilter === "manga" ? setMangaDexOpen(true) : typeFilter === "game" ? setIgdbOpen(true) : typeFilter === "movie" ? setTmdbOpen(true) : setEditMode({ kind: "create", type: typeFilter })}>{typeFilter === "manga" ? "MangaDex에서 만화 추가" : typeFilter === "game" ? "IGDB에서 게임 추가" : typeFilter === "movie" ? "TMDB에서 영화 추가" : "직접 입력"}</Button></EmptyState>;

  const viewControls = libraryView ? <>
    <Menu label="정렬" align="end" triggerClassName="asset-toolbar__quiet-menu" trigger={<>정렬<ChevronDownIcon aria-hidden="true" /></>} items={[
      ...(typeFilter === "game" ? ([['device', '기기'], ['year', '발매 연도']] as const).map(([grouping, label]) => ({ id: grouping, label, group: "grouping", selected: viewSettings.grouping === grouping,
        onSelect: () => { patchViewSettings({ grouping }); if (grouping === "year") patchLibraryState({ sort: "media_date", direction: "desc" }); } })) : []),
      ...SORT_OPTIONS.map(([sort, direction, label]) => ({ id: `${sort}:${direction}`, label, group: "sort", selected: libraryState.sort === sort && libraryState.direction === direction,
        onSelect: () => { patchLibraryState({ sort, direction }); patchViewSettings({ grouping: "sort" }); } })),
    ]} />
    <Menu label="내 별점" align="end" triggerClassName="asset-toolbar__quiet-menu" trigger={<>내 별점<ChevronDownIcon aria-hidden="true" /></>}
      content={<div className="collection-toolbar__rating" onKeyDown={event => event.stopPropagation()}><RatingFilter rating={libraryState.rating} onChange={rating => patchLibraryState({ rating })} />
        {libraryState.rating !== "all" && <Button size="sm" variant="ghost" onClick={() => patchLibraryState({ rating: "all" })}>초기화</Button>}
      </div>} />
    <ViewOptionsMenu layout={viewSettings.layout} options={[{ value: "grid", label: "격자" }, { value: "shelf", label: "선반" }, ...(typeFilter === "manga" ? [{ value: "bookcase" as const, label: "책장" }] : [])]}
      onLayoutChange={layout => patchViewSettings({ layout })} perRow={viewSettings.perRow} min={5} max={12} onPerRowChange={perRow => patchViewSettings({ perRow })} />
  </> : undefined;
  const toolbarControls = libraryView ? <div className="collection-toolbar__controls">
    <Menu label="컬렉션 검색" align="end" triggerClassName="asset-toolbar__quiet-menu" trigger={<><MagnifyingGlassIcon aria-hidden="true" /><span>검색</span></>}
      content={<div className="collection-toolbar__rating" onKeyDown={event => event.stopPropagation()}>
        <TextInput type="search" aria-label="제목 검색" placeholder="작품 제목 검색" autoFocus value={libraryState.query} onChange={event => patchLibraryState({ query: event.target.value })} />
      </div>} />
    {typeFilter === "game" && gateway.fetchLaunchBoxSpines && <Menu label="작품 관리" align="end" triggerClassName="asset-toolbar__quiet-menu" trigger={<EllipsisHorizontalIcon aria-hidden="true" />} items={[
      { id: "spines", label: "책등 받기", disabled: spineBatch.running, onSelect: () => void spineBatch.run(collections, onChanged) },
    ]} />}
    {typeFilter === "game" && spineBatch.running && <span className="collection-toolbar__spine-progress">
      <span role="status" className="collection-toolbar__spine-status">
        <span className="collection-toolbar__spine-spinner" aria-hidden="true" />
        <span className="collection-toolbar__spine-phase">{spineBatch.phase}{" "}</span>
        <span className="collection-toolbar__spine-count">{spineBatch.processed}/{spineBatch.total}</span>
      </span>
      <Button variant="quiet" size="sm" disabled={spineBatch.cancelling} onClick={() => void spineBatch.cancel()}>취소</Button>
    </span>}
  </div> : undefined;

  const sectionDrop = useSectionDrop({ label: "컬렉션 유형", options: typeOptions, value: typeFilter, onChange: setTypeFilter, trailing: viewControls, extra: shortcuts }, !inbox, "컬렉션");

  const chrome: ViewChromeSpec = {
    actions: collectionActions,
    summary: `${sortLabel(libraryState.sort, libraryState.direction)}${libraryState.rating !== "all" ? ` · 내 별점 ${ratingLabel(libraryState.rating)}` : ""}`,
    search: showcase ? undefined : { scope: releaseCalendar ? "발매 캘린더" : releaseProvider ? "신간" : `${sectionLabel} 컬렉션`, query: libraryState.query, label: "제목 검색", placeholder: "작품 제목 검색", onApply: (query) => patchLibraryState({ query }) },
  };

  const scrubberSort = useMemo<ScrubberSort>(() => libraryState.sort === "name"
    ? {kind: "name", values: visible.map(work => work.name)}
    : {kind: "date", values: visible.map(work => libraryState.sort === "recent" ? work.createdAt : work.releaseDate ?? work.createdAt)},
  [visible, libraryState.sort]);
  const scrubberList = useScrubberList(stageRef, mangaBookcase ? ".manga-shelf-list__item" : ".collection-list__cell");
  const shelfPutDown = useShelfPutDown(() => { setPickedId(null); setMangaPick(null); });

  return (
    <section className="collection-browser" aria-label="컬렉션">
      {(!releaseProvider || releaseCalendar) && <ViewToolbar sectionDrop={sectionDrop}
        title={releaseCalendar ? "발매 캘린더" : releaseProvider ? "신간" : showcase ? `${sectionLabel} 쇼케이스` : `${sectionLabel} 컬렉션`}
        titleContent={releaseCalendar ? "발매 캘린더" : releaseProvider ? "신간" : showcase ? `${sectionLabel} 쇼케이스` : sectionLabel}
        titleAccessory={<>{!inbox && <span className="collection-toolbar__count">{visible.length.toLocaleString()}</span>}{toolbarControls}</>}
        ariaLabel="컬렉션 도구"
        leadingAction={libraryView ? undefined : <Button size="icon" variant="ghost" aria-label="컬렉션으로 돌아가기" onClick={inbox ? closeInbox : () => setShowcase(false)}><ChevronLeftIcon aria-hidden="true" /></Button>}
        chrome={chrome}
      />}
      {spineBatch.message && <Toast tone={spineBatch.error ? "error" : "status"} onDismiss={spineBatch.dismiss}>{spineBatch.message}</Toast>}
      {message && <Toast onDismiss={() => setMessage(null)}>{message}</Toast>}
      <div className={`collection-browser__stage${showcase ? " collection-browser__stage--showcase" : ""}`}>
        {!inbox && !workspace && <div className="collection-browser__heading">
          <div>
            <h3>{sectionLabel} {showcase ? "쇼케이스" : "컬렉션"}</h3>
          </div>
          <span>{showcase ? "선정 작품" : "작품"} {visible.length}개</span>
        </div>}
        <div
          className="collection-browser__content-final"
          onContextMenu={(event) => {
            if (inbox || (event.target as HTMLElement).closest(".collection-card, .manga-shelf-row, .ui-section-bar")) return;
            event.preventDefault();
            setEditMode({ kind: "create", type: typeFilter });
          }}
        >
          {releaseProvider && !releaseCalendar && <CollectionReleases chrome={chrome} onBack={closeInbox} provider={releaseProvider} collections={collections} data={releases.data} loading={releases.loading} error={releases.error}
            query={libraryState.query} coverUrl={collectionCoverUrl} onOpen={collectionId => onViewChange({ kind: "collection", collectionId })} onChanged={onChanged} onProviderChange={openInbox} />}
          {releaseCalendar && <ReleaseCalendarView query={libraryState.query} onWishlistChange={loadWishlistUnread}
            onOpenSettings={() => onViewChange({ kind: "settings", section: "connection" })} />}
          {!inbox && showcase && visible.length > 0 && <><SectionDropMount host=".collection-browser" target=".collection-exhibition">{sectionDrop.inline}</SectionDropMount>
            <CollectionExhibition items={visible} page={exhibition.page} onPageChange={changeExhibitionPage} render={collection => renderCollection(collection)} scrollRef={stageRef} /></>}
          {!inbox && showcase && visible.length === 0 && <div className="collection-browser__showcase-scroll">{sectionDrop.inline}<div className="collection-browser__empty"><EmptyState title="쇼케이스에 컬렉션이 없습니다.">라이브러리에서 쇼케이스에 추가한 컬렉션이 여기에 표시됩니다.</EmptyState></div></div>}
          {!inbox && !showcase && <div ref={stageRef} className="collection-browser__list-scroll" tabIndex={0} data-cover-scroll-root="" {...shelfPutDown}>
            {sectionDrop.inline}
            {leading}
            {mangaBookcase ? mangaShelfList(libraryItems, `${sectionLabel} 작품 목록`)
              : <CollectionList items={libraryItems} windowRows pickedId={pickedId} restoredFocusId={navigationMemory?.get(scope)?.focusId} view={viewSettings} render={renderCollection} label={`${sectionLabel} 작품 목록`} onPick={setPickedId} />}
            {visible.length === 0 && <div className="collection-browser__empty">{emptyLibrary}</div>}
          </div>}
          {!inbox && !showcase && <Scrubber key={`${typeFilter}:${viewSettings.layout}`} input="pointer" scrollRef={stageRef} total={visible.length} sort={scrubberSort} {...scrubberList} />}

        </div>
      </div>
      {editMode && (
        <CollectionEditDialog
          open
          mode={editMode}
          onClose={() => setEditMode(null)}
          onSubmit={handleSubmit}
          onSubmitMangaSettings={editMode.kind === "edit" && editMode.collection.type === "manga" ? handleMangaSettings : undefined}
        />
      )}
      {mangaDexOpen && (
        <MangaDexImportDialog
          open
          target={{ kind: "new" }}
          onClose={() => setMangaDexOpen(false)}
          onApplied={async (collection) => {
            await onChanged();
            onViewChange({ kind: "collection", collectionId: collection.id });
          }}
        />
      )}
      {igdbOpen && (
        <IgdbImportDialog
          open
          target={{ kind: "new" }}
          onClose={() => setIgdbOpen(false)}
          onOpenSettings={() => {
            setIgdbOpen(false);
            onViewChange({ kind: "settings", section: "connection" });
          }}
          onApplied={async (collection) => {
            try {
              await onChanged();
              onViewChange({ kind: "collection", collectionId: collection.id });
            } catch (error) {
              setMessage(commandErrorMessage(error, "IGDB 게임을 불러온 뒤 화면을 갱신하지 못했습니다."));
            }
          }}
        />
      )}
      {tmdbOpen && (
        <TmdbMovieDialog
          open
          target={{ kind: "new" }}
          onClose={() => setTmdbOpen(false)}
          onOpenSettings={() => {
            setTmdbOpen(false);
            onViewChange({ kind: "settings", section: "connection" });
          }}
          onApplied={async (collection) => {
            try {
              await onChanged();
              onViewChange({ kind: "collection", collectionId: collection.id });
            } catch (error) {
              setMessage(commandErrorMessage(error, "TMDB 영화를 불러온 뒤 화면을 갱신하지 못했습니다."));
            }
          }}
        />
      )}
      {deleteTarget && (
        <Dialog open title="컬렉션 삭제" onClose={() => setDeleteTarget(null)}>
          <div className="collection-browser__delete">
            <p>컬렉션 '{deleteTarget.name}'을 삭제합니다. 속한 자산은 라이브러리에 보존됩니다.</p>
            <div className="ui-dialog__actions">
              <Button type="button" onClick={() => setDeleteTarget(null)}>취소</Button>
              <Button type="button" variant="danger" onClick={() => void removeCollection()}>삭제</Button>
            </div>
          </div>
        </Dialog>
      )}
    </section>
  );
}

const SORT_OPTIONS: Array<[CollectionLibrarySort, "asc" | "desc", string]> = [
  ["media_date", "desc", "최신순"],
  ["media_date", "asc", "오래된순"],
  ["recent", "desc", "최근 추가 · 최신순"],
  ["recent", "asc", "최근 추가 · 오래된순"],
  ["name", "asc", "제목 · 가나다순"],
  ["name", "desc", "제목 · 역순"],
];

function sortLabel(sort: CollectionLibrarySort, direction: "asc" | "desc"): string {
  return SORT_OPTIONS.find(([value, order]) => value === sort && order === direction)?.[2] ?? "최근 추가";
}

/** Slider stops: 전체, then 0.5 … 5.0. 미평가 is a separate toggle, never a stop. */
const RATING_STEPS: Array<CollectionLibraryState["rating"]> = ["all", 0.5, 1, 1.5, 2, 2.5, 3, 3.5, 4, 4.5, 5];

function ratingLabel(rating: CollectionLibraryState["rating"]): string {
  return rating === "all" ? "전체" : rating === "unrated" ? "미평가" : rating.toFixed(1);
}

/** The slider stop for a filter; a saved score between stops (for example 0.0) sits on the nearest. */
function ratingStep(rating: CollectionLibraryState["rating"]): number {
  if (typeof rating !== "number") return 0;
  return Math.min(10, Math.max(1, Math.round(rating * 2)));
}

function RatingFilter({ rating, onChange }: { rating: CollectionLibraryState["rating"]; onChange: (rating: CollectionLibraryState["rating"]) => void }) {
  // Exact match (collectionLibrary `matchesRating`): the slider picks one score, and 미평가 is
  // its own toggle, so the two can never be combined.
  const shown = typeof rating === "number" ? `★ ${rating.toFixed(1)}` : ratingLabel(rating);
  return <div className="collection-rating-filter">
    <Slider label="내 별점" min={0} max={RATING_STEPS.length - 1} step={1} value={rating === "unrated" ? 0 : ratingStep(rating)} aria-valuetext={shown}
      className={rating === "unrated" ? "is-idle" : undefined}
      onChange={event => {
        const next = RATING_STEPS[Number(event.target.value)] ?? "all";
        if (next !== rating) onChange(next);
      }} />
    <div className="collection-rating-filter__row">
      <output className="collection-rating-filter__value">{shown}</output>
      <Button size="sm" variant="secondary" aria-pressed={rating === "unrated"} onClick={() => onChange(rating === "unrated" ? "all" : "unrated")}>미평가</Button>
    </div>
  </div>;
}
