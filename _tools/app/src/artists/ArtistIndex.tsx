import type { ReactNode } from "react";
import { thumbnailUrl } from "../assets/mediaUrl";
import type { ArtistHubSection, AssetView } from "../library/types";
import { EyeSlashIcon, LinkIcon, MergeIcon, MosaicIcon, PeopleIcon, QuestionIcon, StarIcon } from "./artistIcons";
import { useArtistOverview } from "./artistStore";
import { UNKNOWN_NONE, isUnknownArtist } from "./types";
import "./artists.css";

export const isArtistView = (view: AssetView) => view.kind === "artists" || view.kind === "creator";

const count = (value: number | undefined) => value === undefined ? "" : value.toLocaleString("ko-KR");

/** The visible artist total beside the index title. */
export function ArtistIndexCount() {
  const overview = useArtistOverview();
  return overview ? <span className="artist-index__total">{count(overview.total)}</span> : null;
}

/** The 작가 index: 고정, then 모음 (tiers and 작가 미상), then 정리. PC only. */
export function ArtistIndex({ view, onNavigate }: { view: AssetView; onNavigate: (view: AssetView) => void }) {
  const overview = useArtistOverview();
  const section = view.kind === "artists" ? view.section ?? "main" : null;
  const creator = view.kind === "creator" ? view.creatorKey : null;
  const link = (label: string, icon: ReactNode, value: number | undefined, current: boolean, next: AssetView) => (
    <button type="button" className="workspace-index-link artist-index__link" aria-current={current ? "page" : undefined}
      aria-label={value === undefined ? label : `${label} ${count(value)}`} onClick={() => onNavigate(next)}>
      <span className="artist-index__icon" aria-hidden="true">{icon}</span>
      <span className="more-panel__label">{label}</span>
      {value !== undefined && <span className="more-panel__count">{count(value)}</span>}
    </button>
  );
  const sectionLink = (target: ArtistHubSection, label: string, icon: ReactNode, value: number | undefined) =>
    link(label, icon, value, section === target, { kind: "artists", section: target });
  return <nav className="artist-index" aria-label="작가 목록">
    {overview && overview.pinned.length > 0 && <div className="artist-index__group">
      <span className="workspace-section-label">고정</span>
      {overview.pinned.map((artist) => <button key={artist.id} type="button" className="workspace-index-link artist-index__link"
        aria-current={creator === artist.id ? "page" : undefined} aria-label={`${artist.label} ${count(artist.assetCount)}장`}
        onClick={() => onNavigate({ kind: "creator", creatorKey: artist.id })}>
        <span className="artist-index__thumb" aria-hidden="true">{artist.coverAssetIds[0] && <img src={thumbnailUrl(artist.coverAssetIds[0])} alt="" loading="lazy" decoding="async" draggable={false} />}</span>
        <span className="more-panel__label artist-name">{artist.label}</span>
        <span className="more-panel__count">{count(artist.assetCount)}</span>
      </button>)}
    </div>}
    <div className="artist-index__group">
      <span className="workspace-section-label">모음</span>
      {sectionLink("main", "주요 작가", <StarIcon />, overview?.main)}
      {sectionLink("others", "그 외 작가", <PeopleIcon />, overview?.other)}
      {sectionLink("singles", "한 장뿐인 작가들", <MosaicIcon />, overview?.single)}
      {link("작가 미상", <QuestionIcon />, overview?.unknownNone, creator !== null && isUnknownArtist(creator), { kind: "creator", creatorKey: UNKNOWN_NONE })}
    </div>
    <div className="artist-index__group">
      <span className="workspace-section-label">정리</span>
      {sectionLink("merge", "같은 작가일 수 있어요", <MergeIcon />, overview?.mergeSuggestions)}
      {sectionLink("source-fill", "출처에서 작가 채우기", <LinkIcon />, overview?.sourceFillable)}
      {sectionLink("hidden", "숨긴 작가", <EyeSlashIcon />, overview?.hidden)}
    </div>
  </nav>;
}
