import { useEffect, useState } from "react";
import { thumbnailUrl } from "../assets/mediaUrl";
import { HomePresence, HomeSection } from "./HomeAttention";
import type { LibraryGateway, RevisitBundle } from "../library/types";

export function HomeRevisit({ gateway, localDate, privacyMode, onOpenAsset }: {
  gateway: LibraryGateway; localDate: string; privacyMode: boolean; onOpenAsset?: (assetId: string) => void;
}) {
  const [bundle, setBundle] = useState<RevisitBundle | null | undefined>(undefined);
  useEffect(() => {
    let live = true;
    void Promise.resolve().then(() => gateway.getRevisitSlate(localDate, new Date().toISOString()))
      .then((slate) => { if (live) setBundle(slate?.bundles.find((item) => item.kind === "date") ?? null); }, () => undefined);
    return () => { live = false; };
  }, [gateway, localDate]);

  return <HomePresence items={bundle?.assetIds.length ? [{ key: "revisit", content: <HomeSection title={`1년 전 오늘 · ${bundle.assetIds.length.toLocaleString()}장`}><RevisitMosaic assetIds={bundle.assetIds} privacyMode={privacyMode} onOpenAsset={onOpenAsset} /></HomeSection> }] : []} />;
}

function RevisitMosaic({ assetIds, privacyMode, onOpenAsset }: {
  assetIds: string[]; privacyMode: boolean; onOpenAsset?: (assetId: string) => void;
}) {
  const shown = assetIds.slice(0, 5);
  const more = assetIds.length - shown.length;
  return <div className="home-revisit">
    <div className={`home-revisit__pics${shown.length === 0 ? " home-revisit__pics--empty" : ""}`}>
      {shown.length === 0 && <span className="home-revisit__cell" aria-hidden="true" />}
      {shown.map((assetId, index) => <AssetCell key={assetId} assetId={assetId} label="1년 전 오늘" privacyMode={privacyMode} onOpenAsset={onOpenAsset}
        more={index === shown.length - 1 ? more : 0} />)}
    </div>
    <div className="home-revisit__caption"><span>1년 전 오늘</span>{shown.length > 0 && <span className="numeric">{assetIds.length.toLocaleString()}장</span>}</div>
  </div>;
}

function AssetCell({ assetId, label, privacyMode, onOpenAsset, more = 0 }: {
  assetId: string; label: string; privacyMode: boolean; onOpenAsset?: (assetId: string) => void; more?: number;
}) {
  const image = !privacyMode && <img src={thumbnailUrl(assetId)} alt="" loading="lazy" decoding="async" draggable={false} />;
  const content = <>{image}{more > 0 && <span className="home-revisit__more numeric">+{more}</span>}</>;
  return onOpenAsset
    ? <button type="button" className="home-revisit__cell" aria-label={`${label} 이미지 열기`} onClick={() => onOpenAsset(assetId)}>{content}</button>
    : <span className="home-revisit__cell">{content}</span>;
}
