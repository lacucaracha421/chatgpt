import { XMarkIcon } from "@heroicons/react/24/outline";
import type { AssetSummary, ClassificationEntry, CollectionSummary } from "../library/types";
import { Button } from "../shared/ui/Button";
import { OverlayPanel } from "../shared/ui/OverlayPanel";
import { AssetInfoPanel } from "./AssetInfoPanel";

type Props = {
  assets: AssetSummary[];
  currentCollection?: CollectionSummary | null;
  classifications?: ClassificationEntry[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onOpenAsset?: (asset: AssetSummary) => void;
  onAssetUpdated?: (asset: AssetSummary) => void;
  privacyMode?: boolean;
  onAutoTagFilterApplied?: () => void;
  onOpenArtist?: (artistId: string) => void;
  presentation?: "overlay" | "inline";
};

export function AssetInspector({ presentation = "inline", open, onOpenChange, ...panelProps }: Props) {
  if (presentation === "overlay") {
    return <OverlayPanel open={open} onOpenChange={onOpenChange} title="정보" ariaLabel="자산 정보" closeLabel="정보 닫기" width={360}>
      <AssetInfoPanel {...panelProps} />
    </OverlayPanel>;
  }
  if (!open) return null;
  return <aside className="asset-inspector asset-inspector--inline" role="complementary" aria-label="자산 정보" tabIndex={-1} onKeyDown={(event) => {
    if (event.key !== "Escape" || event.defaultPrevented) return;
    event.preventDefault();
    event.stopPropagation();
    onOpenChange(false);
  }}>
    <header className="asset-inspector__header"><strong>정보</strong><Button size="icon" variant="ghost" aria-label="정보 닫기" onClick={() => onOpenChange(false)}><XMarkIcon aria-hidden="true" /></Button></header>
    <AssetInfoPanel {...panelProps} />
  </aside>;
}
