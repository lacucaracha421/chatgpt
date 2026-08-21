type CollectionVolumePanelProps = {
  coverCount: number;
  volumeLabel: string;
};

export function CollectionVolumePanel({
  coverCount,
  volumeLabel,
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
    </aside>
  );
}
