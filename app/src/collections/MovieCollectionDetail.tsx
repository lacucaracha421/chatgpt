import { useState } from "react";
import type { CollectionSummary } from "../library/types";
import { usePrivacy } from "../privacy/PrivacyContext";
import { Menu } from "../shared/ui/Menu";

export type MovieCollectionDetailProps = {
  collection: CollectionSummary;
  posterUrl: string | null;
  backdropUrl: string | null;
  providerConnected: boolean;
  providerBusy: boolean;
  providerError: string | null;
  onEdit(): void;
  onToggleShowcase(): void;
  onDelete(): void;
  onConnectProvider(): void;
  onRefreshProvider(): void;
  onChangeArtwork(): void;
};

export function MovieCollectionDetail({
  collection,
  posterUrl,
  backdropUrl,
  providerConnected,
  providerBusy,
  providerError,
  onEdit,
  onToggleShowcase,
  onDelete,
  onConnectProvider,
  onRefreshProvider,
  onChangeArtwork,
}: MovieCollectionDetailProps) {
  const { privacyMode } = usePrivacy();
  const [failedPoster, setFailedPoster] = useState<string | null>(null);
  const posterVisible = Boolean(posterUrl) && posterUrl !== failedPoster && !privacyMode;
  const [failedBackdrop, setFailedBackdrop] = useState<string | null>(null);
  const backdropVisible = Boolean(backdropUrl) && backdropUrl !== failedBackdrop && !privacyMode;
  const facts = [
    collection.releaseDate,
    collection.runtimeMinutes ? `${collection.runtimeMinutes}분` : null,
    collection.director,
    collection.productionCompany,
    collection.genres,
  ].filter((value): value is string => Boolean(value?.trim()));

  return (
    <article className="movie-collection-detail" aria-label="영화 상세">
      <section
        className={`movie-collection-detail__backdrop${backdropVisible ? "" : " movie-collection-detail__backdrop--empty"}`}
        aria-label="영화 배경 이미지"
      >
        {backdropVisible && <img className="movie-collection-detail__backdrop-art" src={backdropUrl!} alt="" onError={() => setFailedBackdrop(backdropUrl)} />}
        <div className="movie-collection-detail__scrim" aria-hidden="true" />
        <div className="movie-collection-detail__content" data-no-cover={!posterVisible}>
          {posterVisible && <div className="movie-collection-detail__poster">
            {posterUrl && !privacyMode ? <img className="collection-cover-image" src={posterUrl} onError={() => setFailedPoster(posterUrl)} alt={`${collection.name} 포스터`} draggable={false} /> : <span aria-label="포스터 없음" />}
          </div>}
          <div className="movie-collection-detail__identity">
            <div className="movie-collection-detail__actions">
              <Menu
                label="작품 관리"
                trigger="작품 관리"
                items={[
                  { id: "edit", label: "편집", onSelect: onEdit },
                  { id: "showcase", label: collection.showcase ? "쇼케이스에서 제거" : "쇼케이스에 추가", onSelect: onToggleShowcase },
                  { id: "delete", label: "삭제", destructive: true, onSelect: onDelete },
                  ...(!providerConnected ? [{ id: "connect", label: "TMDB에 연결", disabled: providerBusy, onSelect: onConnectProvider }] : []),
                  { id: "refresh", label: "TMDB 새로고침", disabled: !providerConnected || providerBusy, onSelect: onRefreshProvider },
                  { id: "artwork", label: "포스터·배경 변경", disabled: !providerConnected || providerBusy, onSelect: onChangeArtwork },
                ]}
              />
            </div>
            <h1>{collection.name}</h1>
            {collection.originalTitle?.trim() && collection.originalTitle !== collection.name && <p className="movie-collection-detail__original">{collection.originalTitle}</p>}
            {facts.length > 0 && <p className="movie-collection-detail__facts">{facts.join(" · ")}</p>}
            <div className="movie-collection-detail__scores">
              {collection.externalScore !== null && <span>TMDB {collection.externalScore}</span>}
              {collection.myScore !== null && <span>내 평점 {collection.myScore}</span>}
            </div>
          </div>
        </div>
      </section>
      {collection.description?.trim() && <p className="movie-collection-detail__description">{collection.description}</p>}
      {collection.overview?.trim() && <p className="movie-collection-detail__overview">{collection.overview}</p>}
      {providerError && <p className="movie-collection-detail__provider-error" role="alert">{providerError}</p>}
    </article>
  );
}
