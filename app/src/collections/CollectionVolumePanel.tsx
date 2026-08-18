type CollectionVolumePanelProps = {
  coverCount: number;
  volumeLabel: string;
  onVolumeLabelChange: (next: string) => void;
};

export function CollectionVolumePanel({
  coverCount,
  volumeLabel,
  onVolumeLabelChange,
}: CollectionVolumePanelProps) {
  return (
    <aside className="collection-overlay__volume" aria-label="권 정보">
      <div className="collection-overlay__volume-row">
        <span className="collection-overlay__volume-label">표지 수</span>
        <span className="collection-overlay__volume-value">{coverCount}</span>
      </div>
      <div className="collection-overlay__volume-row">
        <span className="collection-overlay__volume-label">권 번호</span>
        <input
          className="collection-overlay__volume-input"
          type="text"
          value={volumeLabel}
          placeholder="—"
          aria-label="권 번호"
          onChange={(event) => onVolumeLabelChange(event.target.value)}
        />
      </div>
    </aside>
  );
}
