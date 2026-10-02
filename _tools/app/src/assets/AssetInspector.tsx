import { XMarkIcon } from "@heroicons/react/24/outline";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
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
  presentation?: "overlay" | "inline" | "docked";
};

export function AssetInspector({ presentation = "inline", open, onOpenChange, ...panelProps }: Props) {
  // Closing usually clears the selection too; keep the last assets on screen while the panel slides out
  // instead of flashing the empty state.
  const lastAssets = useRef(panelProps.assets);
  const dock = useRef<HTMLDivElement>(null);
  const [contentMounted, setContentMounted] = useState(open);
  const opener = useRef<HTMLElement | null>(null);
  useEffect(() => {
    if (presentation !== "docked") return;
    if (open) { setContentMounted(true); return; }
    if (!contentMounted) return;
    const reduced = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
    const timer = window.setTimeout(() => setContentMounted(false), reduced ? 0 : 200);
    return () => window.clearTimeout(timer);
  }, [open, contentMounted, presentation]);
  useLayoutEffect(() => {
    if (presentation !== "docked") return;
    if (open) opener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    else if (opener.current?.isConnected && (dock.current?.contains(document.activeElement) || document.activeElement === document.body)) opener.current.focus({ preventScroll: true });
  }, [open, presentation]);
  useLayoutEffect(() => {
    const element = dock.current;
    if (!element || !open) return;
    const measure = () => { const width = element.getBoundingClientRect().width; if (width > 0) element.style.setProperty("--dock-last-width", `${width}px`); };
    measure();
    if (!window.ResizeObserver) return;
    const observer = new ResizeObserver(measure); observer.observe(element);
    return () => observer.disconnect();
  }, [open, presentation]);
  if (open && panelProps.assets.length > 0) lastAssets.current = panelProps.assets;
  if (presentation === "overlay") {
    return <OverlayPanel open={open} onOpenChange={onOpenChange} title="정보" ariaLabel="자산 정보" closeLabel="정보 닫기" width={360}>
      <AssetInfoPanel {...panelProps} assets={open ? panelProps.assets : lastAssets.current} />
    </OverlayPanel>;
  }
  if (presentation === "docked") return <div ref={dock} className="asset-inspector-dock" data-open={open}>
    <aside className="asset-inspector asset-inspector--docked" role="complementary" aria-label="자산 정보" aria-hidden={!open} inert={!open || undefined} onKeyDown={event => { if (event.key === "Escape" && !event.defaultPrevented) { event.preventDefault(); event.stopPropagation(); onOpenChange(false); } }}>
      <header className="asset-inspector__header"><strong>정보</strong><Button size="icon" variant="ghost" aria-label="정보 닫기" onClick={() => onOpenChange(false)}><XMarkIcon aria-hidden="true" /></Button></header>
      {(open || contentMounted) && <AssetInfoPanel {...panelProps} assets={open ? panelProps.assets : lastAssets.current} />}
    </aside>
  </div>;
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
