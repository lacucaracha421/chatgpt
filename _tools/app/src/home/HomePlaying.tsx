import { useState } from 'react';
import type { CollectionSummary, HomeMedia } from '../library/types';
import { collectionCoverUrl } from '../collections/collectionCover';
import { CollectionShelfCase } from '../collections/case/LightCase';
import { RecordStars } from '../collections/work/WorkRecord';
import { HomeSection } from './HomeAttention';

export function HomePlaying({ collections, records, privacyMode, active, onOpen, onAll }: {
  collections: CollectionSummary[]; records: HomeMedia['playing']; privacyMode: boolean; active: boolean;
  onOpen(id: string): void; onAll(): void;
}) {
  const [hovered, setHovered] = useState<string | null>(null);
  const [focused, setFocused] = useState<string | null>(null);
  const byId = new Map(collections.map(collection => [collection.id, collection]));
  const works = records.flatMap(record => {
    const collection = byId.get(record.collectionId);
    return collection && (collection.type === 'game' || collection.type === 'movie') ? [{ collection, record }] : [];
  });
  if (!works.length) return null;
  return <HomeSection title={`지금 하는 중 · ${works.length}`} onOpen={onAll}>
    <div className="home-playing"><div className="home-playing__track">
      <span className="home-playing__plank" aria-hidden="true" />
      {works.map(({ collection, record }) => <button type="button" className="home-playing__work" key={collection.id} aria-label={`${collection.name} 열기`}
        onMouseEnter={() => setHovered(collection.id)} onMouseLeave={() => setHovered(null)} onFocus={() => setFocused(collection.id)} onBlur={() => setFocused(null)} onClick={() => onOpen(collection.id)}>
        <CollectionShelfCase collection={collection} front={privacyMode ? null : collectionCoverUrl(collection)} privacy={privacyMode} active={active} selected={hovered === collection.id || focused === collection.id} />
        <span className="home-playing__meta"><b>{collection.name}</b><span>{record.ownedPlatform || collection.platforms || (collection.type === 'movie' ? '영화' : '게임')}</span><RecordStars score={record.myScore} /></span>
      </button>)}
    </div></div>
  </HomeSection>;
}
