import { useMemo } from "react";
import { workArtworkThumbnailUrl } from "../assets/mediaUrl";
import type { CollectionVolume } from "../library/types";
import { usePrivacy } from "../privacy/PrivacyContext";
import { PhysicalCover } from "./physical/PhysicalCover";
import { VirtualCoverGrid } from "./physical/VirtualCoverGrid";

type CollectionVolumeGridProps = {
  volumes: CollectionVolume[];
  selectedVolumeId: string | null;
  editionIndex: number;
  onEditionIndexChange: (next: number) => void;
  onSelect: (volumeId: string) => void;
  scope?: string;
  revision?: string;
};
export function CollectionVolumeGrid({ volumes, selectedVolumeId, editionIndex, onEditionIndexChange, onSelect, scope = "", revision = "" }: CollectionVolumeGridProps) {
  const { privacyMode } = usePrivacy();
  const visible = useMemo(() => volumes.filter(volume => volume.editionIndex === editionIndex).sort((a,b) => a.volumeNumber-b.volumeNumber), [volumes,editionIndex]);
  const editions = useMemo(() => [...new Set(volumes.map(volume => volume.editionIndex))].sort((a,b) => a-b), [volumes]);
  return <section className="collection-overlay__grid-area collection-volume-shelf collection-volume-shelf--final" aria-labelledby="collection-volume-grid-heading">
    <div className="collection-overlay__grid-heading">
      <div><h3 id="collection-volume-grid-heading">권별 표지</h3><span>총 {visible.length}권</span></div>
      {editions.length > 1 && <div className="collection-overlay__shelves" role="group" aria-label="판본 선택">
        {editions.map(edition => <button key={edition} type="button" className="collection-overlay__shelf-button" aria-label={`${editionLabel(edition)} 선택`} aria-pressed={editionIndex === edition} onClick={() => onEditionIndexChange(edition)}>{editionLabel(edition)}</button>)}
      </div>}
    </div>
    {visible.length === 0 ? <div className="collection-overlay__cover-empty">이 판본의 표지가 없습니다.</div> :
      <VirtualCoverGrid key={editionIndex} items={visible} itemKey={volume => volume.id} label="권별 표지 목록" centered metadataHeight={38} className="collection-volume-shelf__viewport" render={volume => {
        const label = `${volume.displayLabel}권 표지`;
        return <button type="button" className="collection-overlay__cover-tile" aria-label={volume.coverArtworkId ? label : `${label} 불러오는 중`} aria-pressed={selectedVolumeId === volume.id} onClick={() => onSelect(volume.id)}>
          <span className="collection-volume-shelf__cover">
            {volume.coverArtworkId && !privacyMode ? <PhysicalCover kind="book" src={workArtworkThumbnailUrl(volume.coverArtworkId)} alt={label} scope={scope} revision={revision} /> : <span className="collection-overlay__cover-placeholder" aria-hidden="true" />}
          </span>
          <span className="collection-overlay__cover-label">{volume.displayLabel}</span>
          {volume.releaseStatus === "upcoming" && <span className="collection-overlay__cover-badge" title={volume.localReleaseDate ? `${volume.localReleaseDate} 출간 예정` : undefined}>
            {volume.localReleaseDate ? `${formatKoreanDate(volume.localReleaseDate)} 예정` : "출간 예정"}
          </span>}
        </button>;
      }} />}
  </section>;
}
function editionLabel(index: number) { return index === 0 ? "기본판" : `대체판 ${index}`; }
function formatKoreanDate(value: string) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  return match ? `${match[1]}.${match[2]}.${match[3]}` : value;
}
