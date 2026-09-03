import { ArrowDownIcon, ArrowUpIcon, Bars3BottomLeftIcon, BarsArrowDownIcon, CalendarDaysIcon, ClockIcon, MagnifyingGlassIcon, PlusIcon, StarIcon } from "@heroicons/react/24/outline";
import { useRef, useState } from "react";
import { collectionSourceThumbnailUrl, thumbnailUrl, workArtworkThumbnailUrl } from "../assets/mediaUrl";
import { useLibrary } from "../library/LibraryContext";
import { commandErrorMessage } from "../library/errorMessage";
import type { AssetView, CollectionSummary, CollectionType, CreateCollection, UpdateCollection } from "../library/types";
import { ViewToolbar } from "../layout/ViewToolbar";
import { Button } from "../shared/ui/Button";
import { ContextMenu } from "../shared/ui/ContextMenu";
import { Dialog } from "../shared/ui/Dialog";
import { EmptyState } from "../shared/ui/EmptyState";
import { Menu } from "../shared/ui/Menu";
import { Toast } from "../shared/ui/Toast";
import { useAutoDismiss } from "../shared/ui/useAutoDismiss";
import { CollectionCard } from "./CollectionCard";
import { CollectionEditDialog, type CollectionEditMode } from "./CollectionEditDialog";
import { MangaDexImportDialog } from "./MangaDexImportDialog";
import { IgdbImportDialog } from "./IgdbImportDialog";
import { TmdbMovieDialog } from "./TmdbMovieDialog";
import { deriveCollectionLibrary, type CollectionLibrarySort, type CollectionLibraryState } from "./collectionLibrary";

const TYPE_LABEL: Record<CollectionType, string> = {
  game: "게임",
  manga: "만화",
  movie: "영화",
};

type CollectionBrowserProps = {
  collections: CollectionSummary[];
  typeFilter: CollectionType;
  showcase: boolean;
  onViewChange: (next: AssetView) => void;
  onChanged: () => Promise<void>;
  libraryState: CollectionLibraryState;
  onLibraryStateChange: (next: CollectionLibraryState) => void;
};

export function CollectionBrowser({
  collections,
  typeFilter,
  showcase,
  onViewChange,
  onChanged,
  libraryState,
  onLibraryStateChange,
}: CollectionBrowserProps) {
  const { gateway } = useLibrary();
  const [editMode, setEditMode] = useState<CollectionEditMode | null>(null);
  const [mangaDexOpen, setMangaDexOpen] = useState(false);
  const [igdbOpen, setIgdbOpen] = useState(false);
  const [tmdbOpen, setTmdbOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<CollectionSummary | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const libraryStateRef = useRef(libraryState);
  libraryStateRef.current = libraryState;
  useAutoDismiss(message, setMessage);

  const visible = showcase
    ? collections.filter((collection) => collection.type === typeFilter && collection.showcase).sort((a, b) => (a.showcaseOrder ?? Number.MAX_SAFE_INTEGER) - (b.showcaseOrder ?? Number.MAX_SAFE_INTEGER) || a.name.localeCompare(b.name) || a.id.localeCompare(b.id))
    : deriveCollectionLibrary(collections, typeFilter, libraryState);
  const sectionLabel = TYPE_LABEL[typeFilter];

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

  async function handleSubmit(input: CreateCollection | UpdateCollection) {
    if (editMode?.kind === "create") {
      await gateway.createCollection(input as CreateCollection);
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

  return (
    <section className="collection-browser" aria-label="컬렉션">
      <ViewToolbar
        title="컬렉션"
        ariaLabel="컬렉션 도구"
        actions={
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
        }
      >
        <div className="collection-browser__filters">
          <ModeSegment showcase={showcase} onChange={setShowcase} />
          <TypeSegment current={typeFilter} onChange={setTypeFilter} />
          {!showcase && <div className="collection-browser__library-controls">
            <label className="manga-browser__search">
              <MagnifyingGlassIcon aria-hidden="true" />
              <input type="search" aria-label="제목 검색" placeholder="제목 검색" value={libraryState.query} onChange={(event) => patchLibraryState({ query: event.target.value })} />
            </label>
            <span className="collection-browser__icon-control" title={`정렬: ${sortLabel(libraryState.sort)}`}>
              <Menu label={`정렬: ${sortLabel(libraryState.sort)}`} trigger={<BarsArrowDownIcon aria-hidden="true" />} items={[
                { id: "media_date", label: "출시·출간·개봉일", icon: <CalendarDaysIcon />, selected: libraryState.sort === "media_date", onSelect: () => patchLibraryState({ sort: "media_date" }) },
                { id: "recent", label: "최근 추가", icon: <ClockIcon />, selected: libraryState.sort === "recent", onSelect: () => patchLibraryState({ sort: "recent" }) },
                { id: "name", label: "제목", icon: <Bars3BottomLeftIcon />, selected: libraryState.sort === "name", onSelect: () => patchLibraryState({ sort: "name" }) },
              ]} />
            </span>
            <Button size="icon" variant="ghost" title={libraryState.direction === "desc" ? "내림차순" : "오름차순"} aria-label={libraryState.direction === "desc" ? "내림차순" : "오름차순"} onClick={() => patchLibraryState({ direction: libraryState.direction === "desc" ? "asc" : "desc" })}>
              {libraryState.direction === "desc" ? <ArrowDownIcon aria-hidden="true" /> : <ArrowUpIcon aria-hidden="true" />}
            </Button>
            <span className="collection-browser__icon-control" title={`내 별점: ${ratingLabel(libraryState.rating)}`}>
              <Menu label={`내 별점: ${ratingLabel(libraryState.rating)}`} trigger={<StarIcon aria-hidden="true" />} items={[
                { id: "all", label: "전체", selected: libraryState.rating === "all", onSelect: () => patchLibraryState({ rating: "all" }) },
                ...[5, 4.5, 4, 3.5, 3, 2.5, 2, 1.5, 1, 0.5, 0].map((rating) => ({ id: String(rating), label: rating.toFixed(1), selected: libraryState.rating === rating, onSelect: () => patchLibraryState({ rating }) })),
                { id: "unrated", label: "미평가", selected: libraryState.rating === "unrated", onSelect: () => patchLibraryState({ rating: "unrated" }) },
              ]} />
            </span>
          </div>}
        </div>
      </ViewToolbar>
      {message && <Toast onDismiss={() => setMessage(null)}>{message}</Toast>}
      <div className={`collection-browser__stage${showcase ? " collection-browser__stage--showcase" : ""}`}>
        <div className="collection-browser__heading">
          <div>
            <h3>{sectionLabel} {showcase ? "쇼케이스" : "컬렉션"}</h3>
          </div>
          <span>{showcase ? "선정 작품" : "작품"} {visible.length}개</span>
        </div>
        <div
          className="collection-browser__grid"
          onContextMenu={(event) => {
            if ((event.target as HTMLElement).closest(".collection-card")) return;
            event.preventDefault();
            setEditMode({ kind: "create", type: typeFilter });
          }}
        >
          {visible.map((collection) => (
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
                onClick={() => onViewChange({ kind: "collection", collectionId: collection.id })}
              />
            </ContextMenu>
          ))}
          {visible.length === 0 && (
            <div className="collection-browser__empty">
              <EmptyState title={showcase ? "쇼케이스에 컬렉션이 없습니다." : "컬렉션이 없습니다."}>
                {showcase ? "라이브러리에서 쇼케이스에 추가한 컬렉션이 여기에 표시됩니다." : <><p>새 컬렉션을 만들어 작품을 모아보세요.</p><Button type="button" onClick={() => typeFilter === "manga" ? setMangaDexOpen(true) : typeFilter === "game" ? setIgdbOpen(true) : typeFilter === "movie" ? setTmdbOpen(true) : setEditMode({ kind: "create", type: typeFilter })}>{typeFilter === "manga" ? "MangaDex에서 만화 추가" : typeFilter === "game" ? "IGDB에서 게임 추가" : typeFilter === "movie" ? "TMDB에서 영화 추가" : "직접 입력"}</Button></>}
              </EmptyState>
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

function sortLabel(sort: CollectionLibrarySort): string {
  return sort === "media_date" ? "출시·출간·개봉일" : sort === "name" ? "제목" : "최근 추가";
}

function ratingLabel(rating: CollectionLibraryState["rating"]): string {
  return rating === "all" ? "전체" : rating === "unrated" ? "미평가" : rating.toFixed(1);
}

function TypeSegment({
  current,
  onChange,
}: {
  current: CollectionType;
  onChange: (next: CollectionType) => void;
}) {
  const options: Array<[CollectionType, string]> = [
    ["game", "게임"],
    ["manga", "만화"],
    ["movie", "영화"],
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
  return <div className="collection-browser__segment" role="group" aria-label="보기">
    <button type="button" className="collection-browser__segment-button" aria-pressed={!showcase} onClick={() => onChange(false)}>라이브러리</button>
    <button type="button" className="collection-browser__segment-button" aria-pressed={showcase} onClick={() => onChange(true)}>쇼케이스</button>
  </div>;
}
