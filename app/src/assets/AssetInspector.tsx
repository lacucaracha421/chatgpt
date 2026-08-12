import { ArrowTopRightOnSquareIcon, CheckIcon, MinusIcon, XMarkIcon } from "@heroicons/react/24/outline";
import { openUrl } from "@tauri-apps/plugin-opener";
import { useEffect, useRef, useState } from "react";
import { useLibrary } from "../library/LibraryContext";
import type { AlbumEntry, AssetSummary, ClassificationEntry } from "../library/types";
import { Button } from "../shared/ui/Button";
import { formatBytes, localDate, sourceLabel } from "./assetMetadata";

export function AssetInspector({ assets, classifications, albums, open, membershipVersion = 0, onOpenChange, onMoveToFolder, onPatchAlbum }: { assets: AssetSummary[]; classifications: ClassificationEntry[]; albums: AlbumEntry[]; open: boolean; membershipVersion?: number; onOpenChange: (open: boolean) => void; onMoveToFolder: (classificationId: string | null) => void; onPatchAlbum: (albumId: string, operation: "add" | "remove") => void }) {
  const { gateway } = useLibrary();
  const [folderIds, setFolderIds] = useState<Array<string | null>>([]);
  const [albumIds, setAlbumIds] = useState<string[]>([]);
  const [membershipError, setMembershipError] = useState(false);
  const reloadRef = useRef(0);
  const assetIds = assets.map((asset) => asset.id).join(",");
  useEffect(() => {
    if (!open || assets.length === 0) return;
    const reload = ++reloadRef.current;
    setMembershipError(false);
    void Promise.all(assets.map(async (asset) => {
      const [folders, memberships] = await Promise.all([
        gateway.getAssetClassifications(asset.id),
        gateway.getAssetAlbums(asset.id),
      ]);
      return { folderId: folders[0] ?? null, albumIds: memberships };
    })).then((results) => {
      if (reload === reloadRef.current) {
        setFolderIds(results.map((result) => result.folderId));
        setAlbumIds(results.flatMap((result) => result.albumIds));
      }
    }).catch(() => { if (reload === reloadRef.current) setMembershipError(true); });
  }, [assetIds, assets, gateway, membershipVersion, open]);
  if (!open) return null;
  const asset = assets.length === 1 ? assets[0] : null;

  return <aside className="asset-inspector" aria-label="자산 정보" onKeyDown={(event) => { if (event.key === "Escape") onOpenChange(false); }}>
    <header className="asset-inspector__header">
      <h2>정보</h2>
      <Button size="icon" variant="ghost" aria-label="정보 닫기" onClick={() => onOpenChange(false)}><XMarkIcon aria-hidden="true" /></Button>
    </header>
    {asset ? <>
      <dl className="asset-inspector__metadata">
        <div><dt>파일명</dt><dd>{asset.originalName}</dd></div>
        <div><dt>출처</dt><dd>{sourceLabel(asset.sourceUrl)}</dd></div>
        <div><dt>가져온 날짜</dt><dd>{localDate(asset.collectedAt)}</dd></div>
        <div><dt>크기</dt><dd>{formatBytes(asset.byteSize)}</dd></div>
      </dl>
      {asset.sourceUrl && <Button variant="ghost" onClick={() => void openUrl(asset.sourceUrl!)}><ArrowTopRightOnSquareIcon aria-hidden="true" />출처 열기</Button>}
    </> : <p>{assets.length > 0 ? `${assets.length}개 자산 선택` : "선택한 자산이 없습니다."}</p>}
    {assets.length > 0 && <section className="asset-inspector__classifications" aria-labelledby="asset-inspector-classifications">
      <h3 id="asset-inspector-classifications">정리</h3>
      {membershipError ? <p className="asset-inspector__membership-error">폴더와 앨범 상태를 불러오지 못했습니다.</p> : <>
        <label className="asset-inspector__folder-select">
          <span>폴더</span>
          <select aria-label="폴더" value={commonFolderValue(folderIds)} onChange={(event) => onMoveToFolder(event.target.value || null)}>
            {commonFolderValue(folderIds) === "__mixed" && <option value="__mixed" disabled>여러 폴더</option>}
            <option value="">미분류</option>
            {classifications.map((entry) => <option key={entry.id} value={entry.id}>{entry.name}</option>)}
          </select>
        </label>
        <h4>앨범</h4>
        <ul>{albums.map((entry) => {
        const count = albumIds.filter((id) => id === entry.id).length;
        const checked = count === assets.length;
        const indeterminate = count > 0 && !checked;
        return <li key={entry.id}>
          <label className="asset-inspector__classification">
            <input type="checkbox" checked={checked} aria-label={`${entry.name} 앨범`} ref={(element) => { if (element) element.indeterminate = indeterminate; }} onChange={() => onPatchAlbum(entry.id, checked ? "remove" : "add")} />
            {indeterminate ? <MinusIcon aria-hidden="true" className="asset-inspector__checkbox-icon" /> : <CheckIcon aria-hidden="true" className="asset-inspector__checkbox-icon" />}
            <span>{entry.name}</span>
          </label>
        </li>;
      })}</ul></>}
    </section>}
  </aside>;
}

function commonFolderValue(folderIds: Array<string | null>): string {
  if (folderIds.length === 0) return "";
  return folderIds.every((id) => id === folderIds[0]) ? folderIds[0] ?? "" : "__mixed";
}
