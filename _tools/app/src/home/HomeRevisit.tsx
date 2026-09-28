import { useEffect, useState } from "react";
import type { ArtistTodayRow } from "../artists/types";
import { thumbnailUrl } from "../assets/mediaUrl";
import type { LibraryGateway, RevisitBundle } from "../library/types";

export function HomeRevisit({ gateway, localDate, privacyMode, onOpenAsset }: {
  gateway: LibraryGateway; localDate: string; privacyMode: boolean; onOpenAsset?: (assetId: string) => void;
}) {
  const [bundle, setBundle] = useState<RevisitBundle | null | undefined>(undefined);
  useEffect(() => {
    let live = true;
    void Promise.resolve().then(() => gateway.getRevisitSlate(localDate, new Date().toISOString()))
      .then((slate) => { if (live) setBundle(slate?.bundles.find((item) => item.kind === "date") ?? null); }, () => { if (live) setBundle(null); });
    return () => { live = false; };
  }, [gateway, localDate]);

  return <RevisitMosaic assetIds={bundle?.assetIds ?? []} privacyMode={privacyMode} onOpenAsset={onOpenAsset} />;
}

export function HomeArtist({ artist, privacyMode, onOpenAsset, onOpenArtist }: {
  artist: ArtistTodayRow | null; privacyMode: boolean; onOpenAsset?: (assetId: string) => void; onOpenArtist?: (artistId: string) => void;
}) {
  const assetIds = artist?.assetIds.slice(0, 4) ?? [];
  const caption = artist?.artist.label ?? "오늘의 작가";
  const captionContent = <><span>{caption}</span>{artist && <span className="numeric">{artist.artist.assetCount.toLocaleString()}장</span>}</>;
  return <div className="home-artist">
    <div className={`home-artist__strip${assetIds.length === 0 ? " home-artist__strip--empty" : ""}`}>
      {assetIds.length === 0 && <span className="home-artist__cell" aria-hidden="true" />}
      {assetIds.map((assetId) => <AssetCell key={assetId} assetId={assetId} label={caption} privacyMode={privacyMode} onOpenAsset={onOpenAsset} artist />)}
    </div>
    {artist && onOpenArtist
      ? <button type="button" className="home-revisit__caption" onClick={() => onOpenArtist(artist.artist.id)}>{captionContent}</button>
      : <div className="home-revisit__caption">{captionContent}</div>}
  </div>;
}

function RevisitMosaic({ assetIds, privacyMode, onOpenAsset }: {
  assetIds: string[]; privacyMode: boolean; onOpenAsset?: (assetId: string) => void;
}) {
  const shown = assetIds.slice(0, 5);
  const more = assetIds.length - shown.length;
  return <section className="home-revisit" aria-label="1년 전 오늘">
    <div className={`home-revisit__pics${shown.length === 0 ? " home-revisit__pics--empty" : ""}`}>
      {shown.length === 0 && <span className="home-revisit__cell" aria-hidden="true" />}
      {shown.map((assetId, index) => <AssetCell key={assetId} assetId={assetId} label="1년 전 오늘" privacyMode={privacyMode} onOpenAsset={onOpenAsset}
        more={index === shown.length - 1 ? more : 0} />)}
    </div>
    <div className="home-revisit__caption"><span>1년 전 오늘</span>{shown.length > 0 && <span className="numeric">{assetIds.length.toLocaleString()}장</span>}</div>
  </section>;
}

function AssetCell({ assetId, label, privacyMode, onOpenAsset, more = 0, artist = false }: {
  assetId: string; label: string; privacyMode: boolean; onOpenAsset?: (assetId: string) => void; more?: number; artist?: boolean;
}) {
  const image = !privacyMode && <img src={thumbnailUrl(assetId)} alt="" loading="lazy" decoding="async" draggable={false} />;
  const content = <>{image}{more > 0 && <span className="home-revisit__more numeric">+{more}</span>}</>;
  return onOpenAsset
    ? <button type="button" className={`home-revisit__cell${artist ? " home-artist__cell" : ""}`} aria-label={`${label} 이미지 열기`} onClick={() => onOpenAsset(assetId)}>{content}</button>
    : <span className={`home-revisit__cell${artist ? " home-artist__cell" : ""}`}>{content}</span>;
}
