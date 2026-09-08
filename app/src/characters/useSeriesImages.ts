import { useEffect, useRef, useState } from "react";
import { characterHubApi } from "./hubApi";
import { useLibrary } from "../library/LibraryContext";
import type { AssetCursor, AssetSummary } from "../library/types";
import { commandErrorMessage } from "../library/errorMessage";

/** Shared library picker; imports go through normal ingestion and duplicate handling. */
export function useSeriesImages(seriesId: string | null, referenceTargetId?: string) {
  const { gateway } = useLibrary();
  const [items, setItems] = useState<AssetSummary[]>([]);
  const [cursor, setCursor] = useState<AssetCursor | string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const active = useRef(true), pending = useRef(false);
  async function load(after: AssetCursor | string | null) {
    if (pending.current || !seriesId) return;
    pending.current = true; setBusy(true); setError(null);
    try {
      const page = referenceTargetId
        ? await characterHubApi.browse({ seriesId, targetId: null, referenceTargetId, all: false, after: after as string | null, limit: 100 })
        : await gateway.listAssets({ classificationId: seriesId, albumId: null, collectionId: null, directOnly: false, unclassifiedOnly: false, mediaKind: "images", aspectRatio: null, sort: "newest", randomPivot: null, after: after as AssetCursor | null, limit: 100 });
      if (active.current) { setItems(old => after ? [...old, ...page.items.filter(a => !old.some(b => b.id === a.id))] : page.items); setCursor(page.nextCursor); }
      return page.items;
    } catch (e) { if (active.current) setError(commandErrorMessage(e, "이미지를 불러오지 못했습니다.")); }
    finally { pending.current = false; if (active.current) setBusy(false); }
  }
  useEffect(() => { active.current = true; void load(null); return () => { active.current = false; }; }, [seriesId, gateway, referenceTargetId]);
  async function importImages(): Promise<string[]> {
    if (pending.current || !seriesId) return [];
    pending.current = true; setBusy(true); setError(null);
    const ids: string[] = [], failures: string[] = [];
    try {
      const { open } = await import("@tauri-apps/plugin-dialog");
      const paths = await open({ multiple: true, directory: false, title: "시리즈에 이미지 가져오기", filters: [{ name: "이미지", extensions: ["png", "jpg", "jpeg", "webp", "bmp", "avif"] }] });
      const batch = crypto.randomUUID();
      for (const sourcePath of paths ? Array.isArray(paths) ? paths : [paths] : []) {
        if (!active.current) break;
        try {
          const result = await gateway.ingestMedia({ sourcePath, classificationId: seriesId, sourceUrl: null, importSource: "direct", importBatchId: batch });
          if (result.status === "added") ids.push(result.asset.id);
          else if (result.status === "exact_duplicate") ids.push(result.existingAssetId);
          else failures.push("유사 이미지 검토가 필요한 파일이 있습니다.");
        } catch (e) { failures.push(commandErrorMessage(e, "가져오지 못한 파일이 있습니다.")); }
      }
    } catch (e) { failures.push(commandErrorMessage(e, "이미지를 가져오지 못했습니다.")); }
    finally { pending.current = false; if (active.current) setBusy(false); }
    if (active.current) { const visible = await load(null); if (referenceTargetId) { const allowed = new Set(visible?.map(a => a.id)); ids.splice(0, ids.length, ...ids.filter(id => allowed.has(id))); } if (failures.length) setError([...new Set(failures)].join(" ")); }
    return ids;
  }
  return { items, cursor, busy, error, load, importImages };
}
