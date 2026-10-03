import {useEffect, useState} from 'react';
import {CenteredFilmstrip} from '../src/shared/viewer/CenteredFilmstrip';
import type {Asset} from './types';
import {loadThumbnail} from './media';

type ViewerFilmstripProps = {
  items: Asset[]; index: number; privacy?: boolean; grown?: boolean;
  onIndex(index: number): void; onSwipeUp?(): void; onInteract?(): void; onInteractionChange?(active: boolean): void;
};
const loadedThumbnails = new Map<string, string>();
function Thumbnail({asset, privacy}: {asset: Asset; privacy: boolean}) {
  const cacheKey = `${asset.id}:${asset.thumbnail_revision ?? ''}`;
  const [preview, setPreview] = useState(() => asset.preview ?? loadedThumbnails.get(cacheKey));
  useEffect(() => {
    const ready = asset.preview ?? loadedThumbnails.get(cacheKey);
    setPreview(ready);
    if (privacy || ready || asset.thumbnail_available === false || typeof loadThumbnail !== 'function') return;
    const controller = new AbortController();
    void loadThumbnail(asset, controller.signal).then(result => {
      if (!controller.signal.aborted && result.preview) {
        loadedThumbnails.set(cacheKey, result.preview);
        while (loadedThumbnails.size > 240) loadedThumbnails.delete(loadedThumbnails.keys().next().value!);
        setPreview(result.preview);
      }
    }, () => {});
    return () => controller.abort();
  }, [asset.id, asset.preview, asset.thumbnail_available, cacheKey, privacy]);
  return privacy || !preview ? <span className="centered-filmstrip__placeholder" aria-hidden="true"/> : <img src={preview} alt="" loading="lazy" decoding="async" draggable={false}/>;
}
export function ViewerFilmstrip({items, index, privacy = false, grown, onIndex, onSwipeUp, onInteract, onInteractionChange}: ViewerFilmstripProps) {
  return <CenteredFilmstrip items={items} index={index} height={132} grown={grown} className="viewer-filmstrip" onIndex={onIndex} onSwipeUp={onSwipeUp} onInteract={onInteract} onInteractionChange={onInteractionChange} renderThumbnail={(_, i) => <Thumbnail asset={items[i]} privacy={privacy}/>}/>;
}
