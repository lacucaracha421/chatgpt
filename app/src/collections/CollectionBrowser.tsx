import { PlusIcon } from "@heroicons/react/24/outline";
import { useState } from "react";
import { collectionSourcePreviewUrl, thumbnailUrl } from "../assets/mediaUrl";
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

type CollectionBrowserProps = {
  collections: CollectionSummary[];
  typeFilter: CollectionType | null;
  showcase: boolean;
  onViewChange: (next: AssetView) => void;
  onChanged: () => Promise<void>;
};

export function CollectionBrowser({
  collections,
  typeFilter,
  showcase,
  onViewChange,
  onChanged,
}: CollectionBrowserProps) {
  const { gateway } = useLibrary();
  const [editMode, setEditMode] = useState<CollectionEditMode | null>(null);
  const [mangaDexOpen, setMangaDexOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<CollectionSummary | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  useAutoDismiss(message, setMessage);

  const visible = collections.filter((collection) => {
    if (showcase && !collection.showcase) return false;
    if (typeFilter && collection.type !== typeFilter) return false;
    return true;
  });

  function setTypeFilter(next: CollectionType | null) {
    onViewChange({ kind: "collections", typeFilter: next, showcase });
  }

  function setShowcase(next: boolean) {
    onViewChange({ kind: "collections", typeFilter, showcase: next });
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
              { id: "mangadex", label: "MangaDex에서 만화 추가", onSelect: () => setMangaDexOpen(true) },
              { id: "manual", label: "직접 입력", onSelect: () => setEditMode({ kind: "create" }) },
            ]}
          />
        }
      >
        <div className="collection-browser__filters">
          <TypeSegment current={typeFilter} onChange={setTypeFilter} />
          <button
            type="button"
            className="collection-browser__showcase"
            aria-pressed={showcase}
            onClick={() => setShowcase(!showcase)}
          >
            쇼케이스
          </button>
        </div>
      </ViewToolbar>
      {message && <Toast onDismiss={() => setMessage(null)}>{message}</Toast>}
      <div
        className="collection-browser__grid"
        onContextMenu={(event) => {
          if ((event.target as HTMLElement).closest(".collection-card")) return;
          event.preventDefault();
          setEditMode({ kind: "create" });
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
                collection.coverAssetId
                  ? thumbnailUrl(collection.coverAssetId)
                  : collection.sourcePath
                    ? collectionSourcePreviewUrl(collection.id)
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
              {showcase ? "쇼케이스로 표시한 컬렉션이 여기에 표시됩니다." : "새 컬렉션을 만들어 작품을 모아보세요."}
            </EmptyState>
          </div>
        )}
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

function TypeSegment({
  current,
  onChange,
}: {
  current: CollectionType | null;
  onChange: (next: CollectionType | null) => void;
}) {
  const options: Array<[CollectionType | null, string]> = [
    [null, "전체"],
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
