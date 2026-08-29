import type { CollectionSummary } from "../library/types";

type CollectionInfoPanelProps = {
  collection: CollectionSummary;
};

export function CollectionInfoPanel({ collection }: CollectionInfoPanelProps) {
  const rows: Array<[string, string]> = [];
  if (collection.author) rows.push(["작가", collection.author]);
  if (collection.year !== null && collection.year !== undefined) rows.push(["연도", String(collection.year)]);
  if (collection.director) rows.push(["감독", collection.director]);
  if (collection.genres) rows.push(["장르", collection.genres]);
  if (collection.description?.trim()) rows.push(["설명", collection.description]);

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
      {collection.overview && (
        <div className="collection-overlay__overview">
          <p>{collection.overview}</p>
        </div>
      )}
    </aside>
  );
}
