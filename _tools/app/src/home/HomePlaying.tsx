import type { CollectionSummary, HomeMedia } from '../library/types';
import { collectionCoverUrl } from '../collections/collectionCover';
import { CollectionShelfCase } from '../collections/case/LightCase';
import { HomePlayingShelf } from './HomePlayingShelf';

export function HomePlaying({ collections, records, privacyMode, active, onOpen, onAll }: {
  collections: CollectionSummary[]; records: HomeMedia['playing']; privacyMode: boolean; active: boolean;
  onOpen(id: string): void; onAll(): void;
}) {
  const byId = new Map(collections.map(collection => [collection.id, collection]));
  const works = records.flatMap(record => {
    const collection = byId.get(record.collectionId);
    return collection && (collection.type === 'game' || collection.type === 'movie') ? [{ collection, record }] : [];
  });
  return <HomePlayingShelf onOpen={onOpen} onAll={onAll} works={works.map(({ collection, record }) => ({
    id: collection.id, name: collection.name, platform: record.ownedPlatform || collection.platforms || (collection.type === 'movie' ? '영화' : '게임'), score: record.myScore,
    case: selected => <CollectionShelfCase collection={collection} front={privacyMode ? null : collectionCoverUrl(collection)} privacy={privacyMode} active={active} selected={selected} />,
  }))} />;
}
