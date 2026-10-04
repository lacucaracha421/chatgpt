import { useEffect, useState } from 'react';
import type { HomeMedia, LibraryGateway, RevisitBundle } from '../library/types';

export type HomeMediaSnapshot = HomeMedia & { anniversary: RevisitBundle | null };

/** Read together so a late anniversary never briefly shows the quiet-day fallback. */
export function useHomeMedia(gateway: LibraryGateway, localDate: string, active: boolean, refreshVersion: string | number) {
  const [data, setData] = useState<HomeMediaSnapshot | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    if (!active) return;
    let live = true;
    void Promise.all([
      gateway.getHomeMedia?.(localDate) ?? Promise.resolve({ playing: [], dailyAsset: null }),
      Promise.resolve().then(() => gateway.getRevisitSlate(localDate, new Date().toISOString())),
    ]).then(([media, slate]) => {
      if (!live) return;
      setData({ ...media, anniversary: slate?.bundles.find(bundle => bundle.kind === 'date' && bundle.assetIds.length > 0) ?? null });
      setFailed(false);
    }, () => { if (live) setFailed(true); });
    return () => { live = false; };
  }, [gateway, localDate, active, refreshVersion]);
  return { data, failed };
}
