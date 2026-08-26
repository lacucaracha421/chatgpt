import { useState, type PointerEvent } from "react";
import type { CollectionSummary } from "../library/types";
import { Menu } from "../shared/ui/Menu";

export type GameCollectionDetailProps = {
  collection: CollectionSummary;
  coverUrl: string | null;
  heroUrl: string | null;
  providerConnected: boolean;
  providerBusy: boolean;
  providerError: string | null;
  onEdit(): void;
  onToggleShowcase(): void;
  onDelete(): void;
  onRefreshProvider(): void;
  onChangeArtwork(): void;
};

export function GameCollectionDetail({
  collection,
  coverUrl,
  heroUrl,
  providerConnected,
  providerBusy,
  providerError,
  onEdit,
  onToggleShowcase,
  onDelete,
  onRefreshProvider,
  onChangeArtwork,
}: GameCollectionDetailProps) {
  const [lifted, setLifted] = useState(false);

  function clearTilt(button: HTMLButtonElement) {
    button.style.removeProperty("--game-package-tilt-x");
    button.style.removeProperty("--game-package-tilt-y");
  }

  function tiltPackage(event: PointerEvent<HTMLButtonElement>) {
    if (!lifted) return;
    const bounds = event.currentTarget.getBoundingClientRect();
    const x = clamp((event.clientX - bounds.left) / bounds.width, 0, 1);
    const y = clamp((event.clientY - bounds.top) / bounds.height, 0, 1);
    event.currentTarget.style.setProperty("--game-package-tilt-x", `${(0.5 - y) * 6}deg`);
    event.currentTarget.style.setProperty("--game-package-tilt-y", `${(x - 0.5) * 6}deg`);
  }

  const metadata: Array<[string, string]> = [
    ["개발사", collection.developer],
    ["배급사", collection.publisher],
    ["최초 출시일", collection.releaseDate],
    ["플랫폼", collection.platforms],
    ["장르", collection.genres],
    ["내 평점", collection.myScore === null ? null : `${collection.myScore}/5`],
  ].filter((entry): entry is [string, string] => Boolean(entry[1]?.trim()));

  return (
    <article className="game-collection-detail" aria-label="게임 상세">
      <section
        className={`game-collection-detail__hero${heroUrl ? "" : " game-collection-detail__hero--empty"}`}
        aria-label="게임 대표 아트워크"
      >
        {heroUrl && (
          <img
            className="game-collection-detail__hero-art"
            src={heroUrl}
            alt={`${collection.name} 대표 아트워크`}
            draggable={false}
          />
        )}
        <div className="game-collection-detail__hero-scrim" aria-hidden="true" />
        <div className="game-collection-detail__hero-content">
          <div className="game-collection-detail__package-stage">
            <button
              type="button"
              className={`game-collection-detail__package${lifted ? " game-collection-detail__package--lifted" : ""}`}
              aria-label="게임 패키지 들어 올리기"
              aria-pressed={lifted}
              onClick={(event) => {
                if (lifted) clearTilt(event.currentTarget);
                setLifted((current) => !current);
              }}
              onPointerMove={tiltPackage}
              onPointerLeave={(event) => clearTilt(event.currentTarget)}
            >
              <span className="game-collection-detail__package-shell" aria-hidden="true" />
              <span className="game-collection-detail__package-spine" aria-hidden="true" />
              <span className="game-collection-detail__package-front">
                {coverUrl ? (
                  <img src={coverUrl} alt={`${collection.name} 표지`} draggable={false} />
                ) : (
                  <span className="game-collection-detail__package-placeholder" aria-hidden="true" />
                )}
              </span>
              <span className="game-collection-detail__package-edge" aria-hidden="true" />
              <span className="game-collection-detail__package-rim" aria-hidden="true" />
            </button>
          </div>
          <div className="game-collection-detail__copy">
            <div className="game-collection-detail__actions">
              <Menu
                label="작품 관리"
                trigger="작품 관리"
                items={[
                  { id: "edit", label: "편집", onSelect: onEdit },
                  {
                    id: "showcase",
                    label: collection.showcase ? "쇼케이스에서 제거" : "쇼케이스에 추가",
                    onSelect: onToggleShowcase,
                  },
                  { id: "delete", label: "삭제", destructive: true, onSelect: onDelete },
                  {
                    id: "provider-status",
                    label: providerConnected ? "IGDB 연결됨" : "IGDB 미연결",
                    disabled: true,
                    onSelect: () => undefined,
                  },
                  {
                    id: "provider-refresh",
                    label: "IGDB 새로고침",
                    disabled: !providerConnected || providerBusy,
                    onSelect: onRefreshProvider,
                  },
                  { id: "artwork", label: "표지·hero 변경", disabled: !providerConnected, onSelect: onChangeArtwork },
                ]}
              />
            </div>
            <h1>{collection.name}</h1>
            {metadata.length > 0 && (
              <dl className="game-collection-detail__facts">
                {metadata.map(([label, value]) => (
                  <div key={label} className="game-collection-detail__fact">
                    <dt>{label}</dt>
                    <dd>{value}</dd>
                  </div>
                ))}
              </dl>
            )}
            {collection.overview?.trim() && <p className="game-collection-detail__overview">{collection.overview}</p>}
          </div>
        </div>
      </section>
      {providerError && <p className="game-collection-detail__provider-error" role="alert">{providerError}</p>}
    </article>
  );
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}
