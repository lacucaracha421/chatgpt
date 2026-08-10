import { ArrowTopRightOnSquareIcon, CheckIcon, MinusIcon, XMarkIcon } from "@heroicons/react/24/outline";
import { openUrl } from "@tauri-apps/plugin-opener";
import { useEffect, useRef, useState } from "react";
import { useLibrary } from "../library/LibraryContext";
import type { AssetSummary, ClassificationEntry } from "../library/types";
import { Button } from "../shared/ui/Button";
import { formatBytes, localDate, sourceLabel } from "./assetMetadata";

export function AssetInspector({ assets, classifications, open, onOpenChange, onPatchClassifications }: { assets: AssetSummary[]; classifications: ClassificationEntry[]; open: boolean; onOpenChange: (open: boolean) => void; onPatchClassifications: (classificationId: string, operation: "add" | "remove") => void }) {
  const { gateway } = useLibrary();
  const [classificationIds, setClassificationIds] = useState<string[]>([]);
  const [membershipError, setMembershipError] = useState(false);
  const reloadRef = useRef(0);
  const assetIds = assets.map((asset) => asset.id).join(",");
  useEffect(() => {
    if (!open || assets.length === 0) return;
    const reload = ++reloadRef.current;
    setMembershipError(false);
    void Promise.all(assets.map((asset) => gateway.getAssetClassifications(asset.id))).then((results) => {
      if (reload === reloadRef.current) setClassificationIds(results.flat());
    }).catch(() => { if (reload === reloadRef.current) setMembershipError(true); });
  }, [assetIds, assets, gateway, open]);
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
      <h3 id="asset-inspector-classifications">분류</h3>
      {membershipError ? <p className="asset-inspector__membership-error">분류 상태를 불러오지 못했습니다.</p> : <ul>{classifications.map((entry) => {
        const count = classificationIds.filter((id) => id === entry.id).length;
        const checked = count === assets.length;
        const indeterminate = count > 0 && !checked;
        return <li key={entry.id}>
          <label className="asset-inspector__classification">
            <input type="checkbox" checked={checked} aria-label={`${entry.name} 분류`} ref={(element) => { if (element) element.indeterminate = indeterminate; }} onChange={() => onPatchClassifications(entry.id, checked ? "remove" : "add")} />
            {indeterminate ? <MinusIcon aria-hidden="true" className="asset-inspector__checkbox-icon" /> : <CheckIcon aria-hidden="true" className="asset-inspector__checkbox-icon" />}
            <span>{entry.name}</span>
          </label>
        </li>;
      })}</ul>}
    </section>}
  </aside>;
}
