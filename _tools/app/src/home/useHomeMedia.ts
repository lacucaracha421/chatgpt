import { useEffect, useState } from 'react';
import type { HomeMedia, LibraryGateway, RevisitBundle } from '../library/types';
import { pcStartupEvent, pcStartupRead } from '../shared/pcPerfLog';

export type HomeMediaSnapshot = HomeMedia & { anniversary: RevisitBundle | null };

/** Read together so a late anniversary never briefly shows the quiet-day fallback. */
export function useHomeMedia(gateway: LibraryGateway, localDate: string, active: boolean, refreshVersion: string | number) {
  const [data, setData] = useState<HomeMediaSnapshot | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    if (!active) return;
    let live = true;
    void Promise.all([
      pcStartupRead('home.media', () => gateway.getHomeMedia?.(localDate) ?? Promise.resolve({ playing: [], dailyAsset: null })),
      pcStartupRead('home.revisit', () => Promise.resolve().then(() => gateway.getRevisitSlate(localDate, new Date().toISOString()))),
    ]).then(([media, slate]) => {
      if (!live) return;
      setData({ ...media, anniversary: slate?.bundles.find(bundle => bundle.kind === 'date' && bundle.assetIds.length > 0) ?? null });
      setFailed(false);
    }, () => { if (live) setFailed(true); });
    return () => { live = false; pcStartupEvent('home.media.invalidated'); };
  }, [gateway, localDate, active, refreshVersion]);
  return { data, failed };
}
