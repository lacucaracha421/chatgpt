import { ChevronRightIcon } from "@heroicons/react/24/outline";
import { useEffect, useState } from "react";
import type { ArtistTodayRow } from "../artists/types";
import { thumbnailUrl } from "../assets/mediaUrl";
import type { LibraryGateway, RevisitBundle } from "../library/types";

/**
 * 다시 보기 on the PC Home, after the tablet Home: two collage blocks side by side — 1년 전
 * 오늘 (the revisit slate's 이맘때 bundle) and 오늘의 작가 (the Artist hub's first pick for today).
 */
export function HomeRevisit({ gateway, localDate, artist, privacyMode, onOpenAsset, onOpenArtist }: {
  gateway: LibraryGateway; localDate: string; artist: ArtistTodayRow | null; privacyMode: boolean;
  onOpenAsset?: (assetId: string) => void; onOpenArtist: (artistId: string) => void;
}) {
  const [bundle, setBundle] = useState<RevisitBundle | null | undefined>(undefined);
  useEffect(() => {
    let live = true;
    void Promise.resolve().then(() => gateway.getRevisitSlate(localDate, new Date().toISOString()))
      .then((slate) => { if (live) setBundle(slate?.bundles.find((item) => item.kind === "date") ?? null); }, () => { if (live) setBundle(null); });
    return () => { live = false; };
  }, [gateway, localDate]);

  return <div className="home-revisits">
    <RevisitBlock title="1년 전 오늘" meta={bundle ? `${bundle.assetIds.length.toLocaleString()}장` : bundle === null ? "이맘때 모은 자료가 없습니다." : "불러오는 중…"}
      assetIds={bundle?.assetIds ?? []} privacyMode={privacyMode} onOpenAsset={onOpenAsset} />
    <RevisitBlock title={artist ? `오늘의 작가 · ${artist.artist.label}` : "오늘의 작가"} meta={artist ? `${artist.reason} · 소장 ${artist.artist.assetCount.toLocaleString()}장` : "오늘 고를 작가가 없습니다."}
      assetIds={artist?.assetIds ?? []} privacyMode={privacyMode} onOpenAsset={onOpenAsset} onOpen={artist ? () => onOpenArtist(artist.artist.id) : undefined} />
  </div>;
}

/** One collage: a large image with two stacked beside it (+N on the last), then a caption. */
function RevisitBlock({ title, meta, assetIds, privacyMode, onOpenAsset, onOpen }: {
  title: string; meta: string; assetIds: string[]; privacyMode: boolean; onOpenAsset?: (assetId: string) => void; onOpen?: () => void;
}) {
  const shown = assetIds.slice(0, 3);
  const more = assetIds.length - shown.length;
  const caption = <><span className="home-revisit__text"><b>{title}</b><small>{meta}</small></span>{onOpen && <ChevronRightIcon aria-hidden="true" className="home-chevron" />}</>;
  return <section className="home-revisit" aria-label={title}>
    <div className={`home-revisit__pics home-revisit__pics--${Math.max(1, shown.length)}`}>
      {shown.length === 0 && <span className="home-revisit__cell" />}
      {shown.map((assetId, index) => {
        const image = !privacyMode && <img src={thumbnailUrl(assetId)} alt="" loading="lazy" decoding="async" draggable={false} />;
        const extra = index === shown.length - 1 && more > 0 && <span className="home-revisit__more numeric">+{more}</span>;
        return onOpenAsset
          ? <button key={assetId} type="button" className="home-revisit__cell" aria-label={`${title} 이미지 열기`} onClick={() => onOpenAsset(assetId)}>{image}{extra}</button>
          : <span key={assetId} className="home-revisit__cell">{image}{extra}</span>;
      })}
    </div>
    {onOpen
      ? <button type="button" className="home-revisit__caption" onClick={onOpen}>{caption}</button>
      : <div className="home-revisit__caption">{caption}</div>}
  </section>;
}
