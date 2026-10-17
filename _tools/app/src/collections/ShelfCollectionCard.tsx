import { memo, useMemo } from "react";
import type { CollectionSummary, ReleaseBoardEntry, ReleaseInboxItem } from "../library/types";
import { ContextMenu, type ContextMenuItem } from "../shared/ui/ContextMenu";
import { CollectionCard } from "./CollectionCard";
import { releaseCaption } from "./releaseCaption";

/**
 * One card of the Collections list with its context menu. Every prop is a value or a stable callback,
 * so picking a case re-renders only the cards whose `picked` changes, not the few dozen mounted ones.
 */
export const ShelfCollectionCard = memo(function ShelfCollectionCard({ collection, coverUrl, picked, shelf, work, boardEntry, inbox, today, menu, onPick, onOpen }: {
  collection: CollectionSummary; coverUrl: string | null; picked: boolean; shelf: boolean;
  /** A case that is picked first and opened on double-click or Enter; a manga row card opens at once. */
  work: boolean;
  boardEntry: ReleaseBoardEntry | undefined; inbox: ReleaseInboxItem[]; today: string;
  menu(collection: CollectionSummary): ContextMenuItem[];
  onPick(id: string): void; onOpen(collection: CollectionSummary): void;
}) {
  const items = useMemo(() => menu(collection), [menu, collection]);
  return <ContextMenu items={items}>
    <CollectionCard
      collection={collection}
      coverUrl={coverUrl}
      selected={picked}
      lightCase
      shelf={shelf}
      releaseCaption={releaseCaption(collection, boardEntry, inbox, today)}
      onClick={() => { if (work) onPick(collection.id); else onOpen(collection); }}
      onDoubleClick={() => { if (work) onOpen(collection); }}
      onKeyDown={event => { if (work && event.key === "Enter") { event.preventDefault(); onOpen(collection); } }}
    />
  </ContextMenu>;
});
