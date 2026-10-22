import {useEffect, useRef, useState} from 'react';
import {Cover} from './CoverGroup';
import {readyFirstScreen} from './firstScreen';
import {api} from './transport';
import type {Asset} from './types';
import './assetStrip.css';

/**
 * Thumbnails that open in the viewer: the PC's same-post grid (`grid`, square cells, the current
 * Asset outlined) and the artist page's 다시보기 strip (`row`, one height, each in its own ratio).
 */
export function AssetStrip({items, label, variant = 'row', currentId, prepared, paused = false, onOpen}: {
  items: Asset[]; label: string; variant?: 'row' | 'grid'; currentId?: string;
  prepared?: ReadonlyMap<string, string>; paused?: boolean; onOpen?(index: number): void;
}) {
  return <div className={`asset-strip asset-strip--${variant}`} role="list" aria-label={label}>
    {items.map((asset, index) => <span key={asset.id} role="listitem" className="asset-strip__cell"
      style={variant === 'row' && asset.width && asset.height ? {aspectRatio: `${asset.width} / ${asset.height}`} : undefined}>
      <button type="button" className="asset-strip__item" aria-current={asset.id === currentId ? 'true' : undefined}
        aria-label={`${label} ${index + 1}번째 열기`} disabled={!onOpen} onClick={() => onOpen?.(index)}>
        <Cover asset={asset} paused={paused} ready={prepared?.get(asset.id)}/>
      </button>
    </span>)}
  </div>;
}

export type PreparedRead<T> = {path: string; reply: T; prepared: ReadonlyMap<string, string>};

/**
 * One GET whose Assets appear with their thumbnails (no pop-in): the reply is reported only after
 * the first thumbnails are fetched and decoded (capped like the gallery's first screen). The last
 * reply stays until the next one is ready; a failed read reports nothing, so the caller shows nothing.
 */
export function usePreparedRead<T>(path: string | null, assetsOf: (reply: T) => Asset[], paused = false) {
  const [state, setState] = useState<PreparedRead<T> | null>(null);
  const select = useRef(assetsOf); select.current = assetsOf;
  useEffect(() => {
    if (!path || paused) return;
    const controller = new AbortController();
    void api<T>(path, controller.signal).then(async reply => {
      const assets = select.current(reply);
      const ready = await readyFirstScreen(assets, controller.signal, assets.length);
      if (controller.signal.aborted) return;
      setState({path, reply, prepared: new Map(ready.flatMap(asset => asset.preview ? [[asset.id, asset.preview] as const] : []))});
    }, () => { if (!controller.signal.aborted) setState(current => current?.path === path ? current : null); });
    return () => controller.abort();
  }, [path, paused]);
  return state;
}
