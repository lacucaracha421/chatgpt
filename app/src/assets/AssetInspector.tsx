import { ArrowTopRightOnSquareIcon, MinusIcon, PlusIcon, XMarkIcon } from "@heroicons/react/24/outline";
import { openUrl } from "@tauri-apps/plugin-opener";
import type { AssetSummary, ClassificationEntry } from "../library/types";
import { Button } from "../shared/ui/Button";
import { formatBytes, localDate, sourceLabel } from "./assetMetadata";

export function AssetInspector({ assets, classifications, open, onOpenChange, onPatchClassifications }: { assets: AssetSummary[]; classifications: ClassificationEntry[]; open: boolean; onOpenChange: (open: boolean) => void; onPatchClassifications: (classificationId: string, operation: "add" | "remove") => void }) {
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
      <ul>{classifications.map((entry) => <li key={entry.id}><span>{entry.name}</span><span>
        <Button size="icon" variant="ghost" aria-label={`${entry.name} 추가`} onClick={() => onPatchClassifications(entry.id, "add")}><PlusIcon aria-hidden="true" /></Button>
        <Button size="icon" variant="ghost" aria-label={`${entry.name} 제거`} onClick={() => onPatchClassifications(entry.id, "remove")}><MinusIcon aria-hidden="true" /></Button>
      </span></li>)}</ul>
    </section>}
  </aside>;
}
