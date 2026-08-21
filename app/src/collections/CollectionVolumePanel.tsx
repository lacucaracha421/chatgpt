type CollectionVolumePanelProps = {
  coverCount: number;
  volumeLabel: string;
  localReleaseDate: string | null;
  isbn13: string | null;
  releaseStatus: "upcoming" | "released" | null;
};

export function CollectionVolumePanel({
  coverCount,
  volumeLabel,
  localReleaseDate,
  isbn13,
  releaseStatus,
}: CollectionVolumePanelProps) {
  return (
    <aside className="collection-overlay__volume" aria-label="권 정보">
      <div className="collection-overlay__volume-row">
        <span className="collection-overlay__volume-label">표지 수</span>
        <span className="collection-overlay__volume-value">{coverCount}</span>
      </div>
      <div className="collection-overlay__volume-row">
        <span className="collection-overlay__volume-label">권 번호</span>
        <span className="collection-overlay__volume-value">{volumeLabel || "—"}</span>
      </div>
      {localReleaseDate && (
        <div className="collection-overlay__volume-row">
          <span className="collection-overlay__volume-label">국내 출간일</span>
          <span className="collection-overlay__volume-value">{formatKoreanDate(localReleaseDate)}</span>
        </div>
      )}
      {isbn13 && (
        <div className="collection-overlay__volume-row">
          <span className="collection-overlay__volume-label">ISBN13</span>
          <span className="collection-overlay__volume-value">{isbn13}</span>
        </div>
      )}
      {releaseStatus && (
        <div className="collection-overlay__volume-row">
          <span className="collection-overlay__volume-label">출간 상태</span>
          <span className="collection-overlay__volume-value">{releaseStatus === "upcoming" ? "출간 예정" : "출간됨"}</span>
        </div>
      )}
    </aside>
  );
}

function formatKoreanDate(value: string) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  return match ? `${match[1]}. ${match[2]}. ${match[3]}.` : value;
}
