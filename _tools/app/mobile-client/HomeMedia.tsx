import {catalogPerfEnabled} from './catalogPerf';
import {useEffect, useState} from 'react';
import {api, native, ApiError} from './transport';
import {mediaTicket} from './media';
import {useTabletAssetMask} from './assetMask';
import {useCachedHomeSourceRead} from './homeCache';
import type {AlbumTree, AlbumAssetPage} from './albumModel';
import type {Asset} from './types';
import {StableImage} from '../src/shared/ui/StableImage';

// Match home_media.rs across restarts: unsigned FNV-1a over the local day and id.
function dailyRank(day: string, id: string) {
  let hash = 0xcbf29ce484222325n;
  for (const byte of new TextEncoder().encode(day + id)) hash = BigInt.asUintN(64, (hash ^ BigInt(byte)) * 0x100000001b3n);
  return hash;
}

export function pickHomeDailyAsset(items: Asset[], day: string): Asset | null {
  const eligible = items.filter(asset => asset.kind === 'image' && Number(asset.width) > 0 && Number(asset.height) > 0 && Number(asset.width) <= Number(asset.height) * 2);
  eligible.sort((a, b) => {
    const preference = Number(Number(a.width) / Number(a.height) > 1.1) - Number(Number(b.width) / Number(b.height) > 1.1);
    if (preference) return preference;
    const left = dailyRank(day, a.id), right = dailyRank(day, b.id);
    return left < right ? -1 : left > right ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
  return eligible[0] ?? null;
}

export function useTabletHomeDaily(enabled: boolean, scope: string, day: string, forceKey: unknown) {
  const [failed, setFailed] = useState(false);
  const read = useCachedHomeSourceRead<{asset: Asset | null; available: boolean} | null>({enabled, scope, source: `daily:${day}`, signalKey: 'listGeneration', initial: null, forceKey,
    read: async signal => {
      setFailed(false);
      try {
        const tree = await native<AlbumTree>('albumTree', {}, signal);
        if (!tree.adopted || !tree.libraryId || tree.epoch === null) return {asset: null, available: false};
        const params = new URLSearchParams({libraryId: tree.libraryId, epoch: String(tree.epoch)});
        const likes = await api<{albumId: string | null}>(`/v1/albums/likes?${params}`, signal);
        if (!likes.albumId) return {asset: null, available: true};
        params.set('albumId', likes.albumId); params.set('limit', '100');
        let pick: Asset | null = null;
        const cursors = new Set<string>();
        for (;;) {
          const page = await api<AlbumAssetPage>(`/v1/albums/assets?${params}`, signal);
          pick = pickHomeDailyAsset([...(pick ? [pick] : []), ...page.items], day);
          if (!page.hasMore) break;
          if (!page.nextCursor || cursors.has(page.nextCursor)) throw new Error('Album cursor did not advance');
          cursors.add(page.nextCursor); params.set('cursor', page.nextCursor);
        }
        setFailed(false);
        return {asset: pick, available: true};
      } catch (reason) {
        if (reason instanceof ApiError && reason.status === 404) return {asset: null, available: false};
        throw reason;
      }
    }, onError: () => setFailed(true),
  });
  return {...read, failed};
}

export function HomeAssetImage({asset, variant, className, paused}: {asset: Asset; variant: 'thumbnail' | 'original'; className?: string; paused: boolean}) {
  const masked = useTabletAssetMask(asset);
  const [url, setUrl] = useState('');
  useEffect(() => {
    if (paused || masked) return;
    const controller = new AbortController();
    void mediaTicket(asset, variant, controller.signal).then(ticket => {if (!controller.signal.aborted) setUrl(ticket.url);}, () => {});
    return () => controller.abort();
  }, [asset.id, asset.thumbnail_revision, variant, paused, masked]);
  return masked ? <span className={`${className ?? ''} privacy-mask`} aria-label="비공개 모드로 이미지 숨김" /> : url ? <StableImage className={className} src={url} alt={variant === 'original' ? '오늘의 한 장' : ''} draggable={false} /> : <span data-perf-image-pending={catalogPerfEnabled()?"true":undefined} className={`${className ?? ''} home-cover-placeholder`} />;
}
