import type { CollectionSummary } from "../library/types";

type CollectionInfoPanelProps = {
  collection: CollectionSummary;
  compact?: boolean;
};

export function CollectionInfoPanel({ collection, compact = false }: CollectionInfoPanelProps) {
  const showDescription = !compact && collection.type !== "game" && collection.type !== "manga";
  const rows: Array<[string, string]> = [];
  if (collection.author) rows.push(["작가", collection.author]);
  if (collection.developer) rows.push(["개발사", collection.developer]);
  if (collection.publisher) rows.push([collection.type === "game" ? "배급사" : "출판사", collection.publisher]);
  if (collection.releaseDate) rows.push(["발매일", collection.releaseDate]);
  else if (collection.year !== null && collection.year !== undefined) rows.push(["연도", String(collection.year)]);
  if (collection.director) rows.push(["감독", collection.director]);
  if (collection.productionCompany) rows.push(["제작사", collection.productionCompany]);
  if (collection.platforms) rows.push(["플랫폼", collection.platforms]);
  if (collection.runtimeMinutes) rows.push(["상영 시간", `${collection.runtimeMinutes}분`]);
  if (collection.myScore != null) rows.push(["내 평점", `${collection.myScore}/5`]);
  if (collection.externalScore != null) rows.push([collection.type === "game" ? "IGDB 평점" : collection.type === "movie" ? "TMDB 평점" : "외부 평점", String(collection.externalScore)]);
  if (collection.genres) rows.push(["장르", collection.genres]);
  if (showDescription && collection.description?.trim()) rows.push(["설명", collection.description]);

  return (
    <aside className="collection-overlay__info" aria-label="컬렉션 정보">
      <h3>작품 정보</h3>
      <dl className="collection-overlay__info-rows">
        {rows.map(([label, value]) => (
          <div className="collection-overlay__info-row" key={label}>
            <dt>{label}</dt>
            <dd>{value}</dd>
          </div>
        ))}
      </dl>
      {showDescription && collection.overview && (
        <div className="collection-overlay__overview">
          <p>{collection.overview}</p>
        </div>
      )}
    </aside>
  );
}
