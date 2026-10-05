import { EmptyState } from "../shared/ui/EmptyState";
import { AssetStableImage as AssetImage } from "../privacy/AssetImage";
import { assetUrl, thumbnailUrl } from "../assets/mediaUrl";
import { HomeSection } from "./HomeAttention";
import type { LibraryGateway } from "../library/types";
import { Button } from "../shared/ui/Button";
import { BusyLabel } from "../shared/ui/BusyLabel";
import { displayDate } from "../shared/displayDate";
import { useHomeMedia, type HomeMediaSnapshot } from "./useHomeMedia";
import type { ReactNode } from 'react';

type HomeImage = (id: string, variant: 'thumbnail' | 'original', className?: string) => ReactNode;

export function HomeRevisit({ gateway, localDate, privacyMode, onOpenAsset, active = true }: {
  gateway: LibraryGateway; localDate: string; privacyMode: boolean; onOpenAsset?: (assetId: string) => void; active?: boolean;
}) {
  const read = useHomeMedia(gateway, localDate, active, 0);
  return <HomeDay data={read.data} failed={read.failed} quiet={false} privacyMode={privacyMode} onOpenAsset={onOpenAsset} />;
}

export function HomeDay({ data, failed, quiet, privacyMode, onOpenAsset, image = defaultImage, emptyAnniversary = false, anniversaryCount }: {
  data: HomeMediaSnapshot | null; failed: boolean; quiet: boolean; privacyMode: boolean; onOpenAsset?: (assetId: string) => void;
  image?: HomeImage; emptyAnniversary?: boolean; anniversaryCount?: number;
}) {
  const bundle = data?.anniversary;
  const asset = data?.dailyAsset;
  const saved = asset ? new Date(asset.collectedAt) : null;
  return <div className="home-day">
    {failed && <EmptyState inline role="status" className="home-attention-empty" title="오늘의 이미지를 확인할 수 없습니다" />}
    {!data && !failed && <div className="home-day__waiting" aria-busy="true"><BusyLabel busy>오늘의 이미지 불러오는 중</BusyLabel></div>}
    {bundle ? <HomeSection title="1년 전 오늘" count={anniversaryCount ?? bundle.assetIds.length} unit="장"><RevisitMosaic assetIds={bundle.assetIds} privacyMode={privacyMode} onOpenAsset={onOpenAsset} image={image} count={anniversaryCount} /></HomeSection>
      : quiet && data && <HomeSection title="오늘의 한 장">{asset ? <div className="home-daily">
        {privacyMode ? <span className="home-daily__mask privacy-mask" aria-label="이미지 숨김" /> : image(asset.id, 'thumbnail', 'home-daily__backdrop')}
        <div className="home-daily__picture">{!privacyMode && image(asset.id, 'original', 'home-daily__image')}</div>
        <div className="home-daily__caption"><span><b>{saved && `${displayDate(saved)}에 저장`}</b><span className="home-daily__favorite">좋아요한 이미지</span></span>
          {onOpenAsset && <Button onClick={() => onOpenAsset(asset.id)}>열기</Button>}
        </div>
      </div> : <EmptyState inline className="home-attention-empty" title="좋아요한 이미지가 생기면 여기에 보여 드립니다" />}</HomeSection>}
    {!bundle && data && !quiet && emptyAnniversary && <HomeSection title="1년 전 오늘"><EmptyState inline className="home-attention-empty" title="1년 전 오늘 저장한 이미지가 없습니다" /></HomeSection>}
  </div>;
}

function RevisitMosaic({ assetIds, privacyMode, onOpenAsset, image, count }: {
  assetIds: string[]; privacyMode: boolean; onOpenAsset?: (assetId: string) => void;
  image: HomeImage; count?: number;
}) {
  const shown = assetIds.slice(0, 5);
  const more = (count ?? assetIds.length) - shown.length;
  return <div className="home-revisit">
    <div className={`home-revisit__pics${shown.length === 0 ? " home-revisit__pics--empty" : ""}`}>
      {shown.length === 0 && <span className="home-revisit__cell" aria-hidden="true" />}
      {shown.map((assetId, index) => <AssetCell key={assetId} assetId={assetId} label="1년 전 오늘" privacyMode={privacyMode} onOpenAsset={onOpenAsset}
        more={index === shown.length - 1 ? more : 0} image={image} />)}
    </div>
    <div className="home-revisit__caption"><span>1년 전 오늘</span>{shown.length > 0 && <span className="numeric">{assetIds.length.toLocaleString()}장</span>}</div>
  </div>;
}

function AssetCell({ assetId, label, privacyMode, onOpenAsset, more = 0, image: renderImage }: {
  assetId: string; label: string; privacyMode: boolean; onOpenAsset?: (assetId: string) => void; more?: number;
  image: HomeImage;
}) {
  const image = !privacyMode && renderImage(assetId, 'thumbnail');
  const content = <>{image}{more > 0 && <span className="home-revisit__more numeric">+{more}</span>}</>;
  return onOpenAsset
    ? <button type="button" className="home-revisit__cell" aria-label={`${label} 이미지 열기`} onClick={() => onOpenAsset(assetId)}>{content}</button>
    : <span className="home-revisit__cell">{content}</span>;
}

function defaultImage(id: string, variant: 'thumbnail' | 'original', className?: string) {
  return className ? <AssetImage className={className} src={variant === 'original' ? assetUrl(id) : thumbnailUrl(id)} alt={variant === 'original' ? '오늘의 한 장' : ''} draggable={false} />
    : <AssetImage src={thumbnailUrl(id)} alt="" loading="lazy" decoding="async" draggable={false} />;
}
