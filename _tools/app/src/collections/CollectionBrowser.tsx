import { PlusIcon } from "@heroicons/react/24/outline";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { collectionSourceThumbnailUrl, thumbnailUrl, workArtworkThumbnailUrl } from "../assets/mediaUrl";
import { useLibrary } from "../library/LibraryContext";
import { commandErrorMessage } from "../library/errorMessage";
import type { AssetView, CollectionSummary, CollectionType, CollectionUpdateProvider, CreateCollection, ReleaseInboxItem, UpdateCollection } from "../library/types";
import { ViewToolbar } from "../layout/ViewToolbar";
import { useWorkspaceChrome } from "../layout/WorkspaceChromeContext";
import { Select } from "../shared/ui/Select";
import { Button } from "../shared/ui/Button";
import { Slider } from "../shared/ui/Slider";
import { ContextMenu } from "../shared/ui/ContextMenu";
import { Dialog } from "../shared/ui/Dialog";
import { EmptyState } from "../shared/ui/EmptyState";
import { Menu } from "../shared/ui/Menu";
import { Toast } from "../shared/ui/Toast";
import { useAutoDismiss } from "../shared/ui/useAutoDismiss";
import { CollectionCard } from "./CollectionCard";
import { VirtualCoverGrid } from "./physical/VirtualCoverGrid";
import { CollectionExhibition, exhibitionPage } from "./physical/CollectionExhibition";
import { CollectionEditDialog, type CollectionEditMode } from "./CollectionEditDialog";
import { MangaDexImportDialog } from "./MangaDexImportDialog";
import { IgdbImportDialog } from "./IgdbImportDialog";
import { TmdbMovieDialog } from "./TmdbMovieDialog";
import { ReleaseInbox, inboxProvider } from "./ReleaseInbox";
import { deriveCollectionLibrary, type CollectionLibrarySort, type CollectionLibraryState } from "./collectionLibrary";
import "./CollectionBrowser.css";

const TYPE_LABEL: Record<CollectionType, string> = {
  game: "게임",
  manga: "만화",
  movie: "영화",
  av: "AV",
};
export type CollectionNavigationMemory = Map<string, { scrollTop: number; focusId: string | null; page?: number }>;

type CollectionBrowserProps = {
  releaseProvider?: CollectionUpdateProvider;
  navigationMemory?: CollectionNavigationMemory;
  collections: CollectionSummary[];
  typeFilter: CollectionType;
  showcase: boolean;
  onViewChange: (next: AssetView) => void;
  onChanged: () => Promise<void>;
  libraryState: CollectionLibraryState;
  onLibraryStateChange: (next: CollectionLibraryState) => void;
};

export function CollectionBrowser({
  releaseProvider,
  navigationMemory,
  collections,
  typeFilter,
  showcase,
  onViewChange,
  onChanged,
  libraryState,
  onLibraryStateChange,
}: CollectionBrowserProps) {
  const { gateway, library } = useLibrary();
  const workspace = useWorkspaceChrome();
  const [editMode, setEditMode] = useState<CollectionEditMode | null>(null);
  const [mangaDexOpen, setMangaDexOpen] = useState(false);
  const [igdbOpen, setIgdbOpen] = useState(false);
  const [tmdbOpen, setTmdbOpen] = useState(false);

  const [deleteTarget, setDeleteTarget] = useState<CollectionSummary | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const tracking = gateway.collectionTracking;
  const alertsAvailable = Boolean(tracking) && typeFilter === "manga" && !showcase;
  const [inbox, setInbox] = useState<ReleaseInboxItem[]>([]);
  useEffect(() => {
    if (!tracking || !alertsAvailable) { setInbox([]); return; }
    let active = true;
    void tracking.listInbox().then(items => { if (active) setInbox(items); }).catch(() => undefined);
    return () => { active = false; };
  }, [tracking, alertsAvailable, collections, releaseProvider]);
  // Unread works per provider (the inbox lists one row per work).
  const unread = { mangadex: 0, kakao: 0 };
  for (const key of new Set(inbox.map(item => `${inboxProvider(item)}:${item.collectionId}`))) unread[key.startsWith("mangadex:") ? "mangadex" : "kakao"] += 1;
  const unreadTotal = unread.mangadex + unread.kakao;
  const openInbox = (provider: CollectionUpdateProvider) => onViewChange({ kind: "collections", typeFilter, showcase, releaseProvider: provider });
  const libraryStateRef = useRef(libraryState);
  libraryStateRef.current = libraryState;
  useAutoDismiss(message, setMessage);
  const stageRef = useRef<HTMLDivElement>(null);
  const [pageMemory, setPageMemory] = useState<{ scope: string; page: number } | null>(null);
  const scope = JSON.stringify([library?.root ?? "", typeFilter, showcase, libraryState, releaseProvider]);
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

  const visible = showcase
    ? collections.filter((collection) => collection.type === typeFilter && collection.showcase).sort((a, b) => (a.showcaseOrder ?? Number.MAX_SAFE_INTEGER) - (b.showcaseOrder ?? Number.MAX_SAFE_INTEGER) || a.name.localeCompare(b.name) || a.id.localeCompare(b.id))
    : deriveCollectionLibrary(collections, typeFilter, libraryState);
  const sectionLabel = TYPE_LABEL[typeFilter];
  const exhibition = exhibitionPage(visible.length, pageMemory?.scope === scope ? pageMemory.page : navigationMemory?.get(scope)?.page ?? 0);
  function changeExhibitionPage(page: number) {
    setPageMemory({ scope, page });
    navigationMemory?.set(scope, { scrollTop: 0, focusId: null, page });
  }

  function setTypeFilter(next: CollectionType) {
    onViewChange({ kind: "collections", typeFilter: next, showcase });
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

  const renderCollection = (collection: CollectionSummary) => (
            <ContextMenu
              key={collection.id}
              items={[
                { id: "edit", label: "편집", onSelect: () => setEditMode({ kind: "edit", collection }) },
                { id: "showcase", label: collection.showcase ? "쇼케이스에서 제거" : "쇼케이스에 추가", onSelect: () => void toggleShowcase(collection) },
                { id: "delete", label: "삭제", destructive: true, onSelect: () => setDeleteTarget(collection) },
              ]}
            >
              <CollectionCard
                collection={collection}
                coverUrl={
                  collection.selectedWorkArtworkId
                    ? workArtworkThumbnailUrl(collection.selectedWorkArtworkId)
                    : collection.coverAssetId
                    ? thumbnailUrl(collection.coverAssetId)
                    : collection.sourcePath
                      ? collectionSourceThumbnailUrl(collection.id)
                      : null
                }
                selected={false}
                scope={library?.root ?? ""}
                exhibition={showcase}
                onClick={() => {
                  navigationMemory?.set(scope, { scrollTop: stageRef.current?.scrollTop ?? 0, focusId: collection.id, page: exhibition.page });
                  onViewChange({ kind: "collection", collectionId: collection.id });
                }}
              />
            </ContextMenu>

  );

  const indexActions = (
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

  const indexControls = <fieldset className="chrome-settings-group"><legend>정렬 · 필터</legend>
            <Select label="정렬" value={`${libraryState.sort}:${libraryState.direction}`} onChange={(event) => {
              const [sort, direction] = event.target.value.split(":") as [CollectionLibrarySort, "asc" | "desc"];
              patchLibraryState({ sort, direction });
            }}>{SORT_OPTIONS.map(([sort, direction, label]) => <option key={`${sort}:${direction}`} value={`${sort}:${direction}`}>{label}</option>)}</Select>
            <RatingFilter rating={libraryState.rating} onChange={rating => patchLibraryState({ rating })} />
          </fieldset>;

  return (
    <section className="collection-browser" aria-label="컬렉션">
      <ViewToolbar
        title={releaseProvider ? `${releaseProvider === "mangadex" ? "MangaDex" : "Kakao"} 알림` : workspace ? `${sectionLabel} ${showcase ? "쇼케이스" : "컬렉션"}` : "컬렉션"}
        ariaLabel="컬렉션 도구"
        chrome={{
          actions: indexActions,
          navigation: <>
            <ModeSegment showcase={showcase} onChange={setShowcase} />
            <span className="workspace-section-label">{showcase ? "전시관" : "작품 유형"}</span>
            <TypeSegment current={releaseProvider ? undefined : typeFilter} onChange={setTypeFilter} />
            {alertsAvailable && <>
              <span className="workspace-section-label">신간</span>
              {/* Unread alerts get the 새 알림 row; at zero only a quiet inbox entry remains for a manual check. */}
              <div className="collection-browser__segment" role="group" aria-label="신간 알림">
                <button type="button" className={`collection-browser__segment-button${unreadTotal > 0 ? "" : " collection-browser__segment-button--quiet"}`} aria-pressed={Boolean(releaseProvider)}
                  aria-description={unreadTotal > 0 ? undefined : "확인하지 않은 알림이 없습니다. 알림함에서 업데이트를 직접 확인할 수 있습니다."}
                  onClick={() => openInbox(releaseProvider ?? (unread.kakao > unread.mangadex ? "kakao" : "mangadex"))}
                >{unreadTotal > 0 ? `새 알림 ${unreadTotal.toLocaleString()}` : "알림함"}</button>
              </div>
            </>}
            {!showcase && !releaseProvider && <div className="chrome-index-controls chrome-settings-controls">{indexControls}</div>}
          </>,
          summary: `${sortLabel(libraryState.sort, libraryState.direction)}${libraryState.rating !== "all" ? ` · 내 별점 ${ratingLabel(libraryState.rating)}` : ""}`,
          status: releaseProvider ? undefined : <span>{showcase ? "선정 작품" : "작품"} {visible.length}개</span>,
          search: showcase ? undefined : { scope: `${sectionLabel} 컬렉션`, query: libraryState.query, label: "제목 검색", placeholder: "작품 제목 검색", onApply: (query) => patchLibraryState({ query }) },
        }}
      />
      {message && <Toast onDismiss={() => setMessage(null)}>{message}</Toast>}
      <div className={`collection-browser__stage${showcase ? " collection-browser__stage--showcase" : ""}`}>
        {!releaseProvider && !workspace && <div className="collection-browser__heading">
          <div>
            <h3>{sectionLabel} {showcase ? "쇼케이스" : "컬렉션"}</h3>
          </div>
          <span>{showcase ? "선정 작품" : "작품"} {visible.length}개</span>
        </div>}
        <div
          className="collection-browser__content-final"
          onContextMenu={(event) => {
            if (releaseProvider || (event.target as HTMLElement).closest(".collection-card")) return;
            event.preventDefault();
            setEditMode({ kind: "create", type: typeFilter });
          }}
        >
          {releaseProvider && <ReleaseInbox provider={releaseProvider} query={libraryState.query} revision={collections} onOpen={collectionId => onViewChange({ kind: "collection", collectionId })} onChanged={onChanged} onProviderChange={openInbox} />}
          {!releaseProvider && visible.length > 0 && (showcase ?
            <CollectionExhibition items={visible} page={exhibition.page} onPageChange={changeExhibitionPage} render={renderCollection} scrollRef={stageRef} /> :
            <VirtualCoverGrid items={visible} itemKey={collection => collection.id} render={renderCollection} legacyMetrics={typeFilter !== "manga"} metadataHeight={56} label={`${sectionLabel} 작품 목록`} scrollRef={stageRef} />)}
          {!releaseProvider && visible.length === 0 && (
            <div className="collection-browser__empty">
              {!showcase && (libraryState.query.trim() || libraryState.rating !== "all") ? <EmptyState title="조건에 맞는 작품이 없습니다."><p>검색어나 별점 조건을 바꿔보세요.</p><Button onClick={() => patchLibraryState({ query: "", rating: "all" })}>검색·필터 초기화</Button></EmptyState> : <EmptyState title={showcase ? "쇼케이스에 컬렉션이 없습니다." : "컬렉션이 없습니다."}>
                {showcase ? "라이브러리에서 쇼케이스에 추가한 컬렉션이 여기에 표시됩니다." : <><p>새 컬렉션을 만들어 작품을 모아보세요.</p><Button type="button" onClick={() => typeFilter === "manga" ? setMangaDexOpen(true) : typeFilter === "game" ? setIgdbOpen(true) : typeFilter === "movie" ? setTmdbOpen(true) : setEditMode({ kind: "create", type: typeFilter })}>{typeFilter === "manga" ? "MangaDex에서 만화 추가" : typeFilter === "game" ? "IGDB에서 게임 추가" : typeFilter === "movie" ? "TMDB에서 영화 추가" : "직접 입력"}</Button></>}
              </EmptyState>}
            </div>
          )}
        </div>
      </div>
      {editMode && (
        <CollectionEditDialog
          open
          mode={editMode}
          onClose={() => setEditMode(null)}
          onSubmit={handleSubmit}
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
            onViewChange({ kind: "settings", section: "external_services" });
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
            onViewChange({ kind: "settings", section: "external_services" });
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

function TypeSegment({
  current,
  onChange,
}: {
  current: CollectionType | undefined;
  onChange: (next: CollectionType) => void;
}) {
  const options: Array<[CollectionType, string]> = [
    ["game", "게임"],
    ["manga", "만화"],
    ["movie", "영화"],
    ["av", "AV"],
  ];
  return (
    <div className="collection-browser__segment" role="group" aria-label="유형">
      {options.map(([value, label]) => (
        <button
          key={value ?? "all"}
          type="button"
          className="collection-browser__segment-button"
          aria-pressed={current === value}
          onClick={() => onChange(value)}
        >
          {label}
        </button>
      ))}
    </div>
  );
}

function ModeSegment({ showcase, onChange }: { showcase: boolean; onChange: (next: boolean) => void }) {
  return <div className="collection-browser__segment collection-browser__segment--context" role="group" aria-label="보기">
    <button type="button" className="collection-browser__segment-button" aria-pressed={!showcase} onClick={() => onChange(false)}>라이브러리</button>
    <button type="button" className="collection-browser__segment-button" aria-pressed={showcase} onClick={() => onChange(true)}>쇼케이스</button>
  </div>;
}
