import {useEffect, useRef, useState} from 'react';
import {errorText, native} from './transport';
import type {Asset} from './types';

/**
 * Explicit 저장/공유 of the original of one ordinary Library Asset (U04).
 *
 * Native fetches the original through the same verified cache the Android file picker uses, then
 * publishes it to MediaStore (Pictures/Movies/Download › Lakomics) or hands its document URI to the
 * system share sheet. A large video can take minutes to arrive, so the bridge deadline is longer.
 * Private Vault media and pending captures never reach this: their viewers do not offer it.
 */
export type AssetExportKind = 'save' | 'share';
export type SavedAsset = {folder: 'pictures' | 'movies' | 'downloads'};
const EXPORT_TIMEOUT_MS = 10 * 60_000;
const NOTICE_MS = 4000;

export function exportAsset(kind: AssetExportKind, asset: Asset, signal?: AbortSignal): Promise<SavedAsset | Record<string, never>> {
  return native(kind === 'save' ? 'assetSave' : 'assetShare', {assetId: asset.id, mime: asset.content_type ?? ''}, signal, EXPORT_TIMEOUT_MS);
}

export function savedNotice(saved: Partial<SavedAsset>): string {
  return saved.folder === 'downloads' ? '다운로드 › Lakomics에 저장했습니다' : '갤러리 › Lakomics에 저장했습니다';
}

/**
 * One export at a time for the open viewer. Leaving the viewer cancels a transfer still running
 * (native then removes its unfinished gallery entry), so a share sheet never opens after it.
 */
export function useAssetExport() {
  const [running, setRunning] = useState<AssetExportKind | null>(null);
  const [notice, setNotice] = useState<{text: string; failed: boolean} | null>(null);
  const controller = useRef<AbortController | null>(null);
  useEffect(() => () => controller.current?.abort(), []);
  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(null), NOTICE_MS);
    return () => window.clearTimeout(timer);
  }, [notice]);
  const run = (kind: AssetExportKind, asset: Asset) => {
    if (controller.current) return;
    const current = new AbortController();
    controller.current = current;
    setRunning(kind);
    setNotice(null);
    exportAsset(kind, asset, current.signal).then(result => {
      if (!current.signal.aborted && kind === 'save') setNotice({text: savedNotice(result as Partial<SavedAsset>), failed: false});
    }, reason => {
      const text = errorText(reason);
      if (!current.signal.aborted && text) setNotice({text: kind === 'save' ? `저장하지 못했습니다. ${text}` : `공유하지 못했습니다. ${text}`, failed: true});
    }).finally(() => {
      if (controller.current === current) controller.current = null;
      if (!current.signal.aborted) setRunning(null);
    });
  };
  return {running, notice, run};
}
