import { MagnifyingGlassIcon } from "@heroicons/react/24/outline";
import { useMemo, useState, type ReactNode } from "react";
import { thumbnailUrl } from "../assets/mediaUrl";
import { createKoreanMatcher } from "../shared/koreanSearch";
import { TextInput } from "../shared/ui/TextInput";
import type { ArtistHubSection, AssetView } from "../library/types";
import { MergeIcon, QuestionIcon, SparklesIcon } from "./artistIcons";
import { useArtistOverview, useArtistRead } from "./artistStore";
import { UNKNOWN_NONE, isUnknownArtist, type ArtistSummary } from "./types";
import "./artists.css";

export const isArtistView = (view: AssetView) => view.kind === "artists" || view.kind === "creator";

const count = (value: number | undefined) => value === undefined ? "" : value.toLocaleString("ko-KR");

/** The visible main-artist total beside the index title for callers that still use it. */
export function ArtistIndexCount() {
  const overview = useArtistOverview();
  return overview ? <span className="artist-index__total">{count(overview.main)}</span> : null;
}

/** The PC 작가 index: pinned artists, the main list, and the two remaining cleanup actions. */
export function ArtistIndex({ view, onNavigate }: { view: AssetView; onNavigate: (view: AssetView) => void }) {
  const overview = useArtistOverview();
  const [query, setQuery] = useState("");
  const trimmedQuery = query.trim();
  const mainPage = useArtistRead(
    // Most-saved artists first (user, 2026-09-29).
    (gateway) => gateway.list({ bucket: "main", sort: "count", limit: 1000 }),
    "index:main:count",
  );
  const searchablePage = useArtistRead(
    trimmedQuery ? (gateway) => gateway.list({ bucket: "all", sort: "recent", limit: 2000 }) : null,
    `index:all:${trimmedQuery}`,
  );
  const matcher = useMemo(() => createKoreanMatcher(trimmedQuery), [trimmedQuery]);
  const pinnedIds = useMemo(() => new Set(overview?.pinned.map((artist) => artist.id) ?? []), [overview?.pinned]);
  const artists = useMemo(() => {
    const source = trimmedQuery ? searchablePage.data?.artists ?? [] : mainPage.data?.artists ?? [];
    return source.filter((artist) => !pinnedIds.has(artist.id) && (!trimmedQuery || matcher([artist.label, artist.displayName, artist.sourceName, ...artist.keys])));
  }, [mainPage.data, matcher, pinnedIds, searchablePage.data, trimmedQuery]);
  const creator = view.kind === "creator" ? view.creatorKey : null;
  const section = view.kind === "artists" ? view.section ?? "main" : null;
  const styleSuggestionCount = overview?.styleSuggestionCount ?? 0;

  return <nav className="artist-index" aria-label="작가 목록">
    <TextInput
      className="artist-index__search-input"
      icon={MagnifyingGlassIcon}
      type="search"
      value={query}
      placeholder="주요 작가 찾기"
      aria-label="주요 작가 찾기"
      onChange={(event) => setQuery(event.target.value)}
    />

    {overview && overview.pinned.length > 0 && <div className="artist-index__group">
      <span className="workspace-section-label">고정</span>
      {overview.pinned.map((artist) => <ArtistRow key={artist.id} artist={artist} current={creator === artist.id} onNavigate={onNavigate} />)}
    </div>}

    <div className="artist-index__group">
      <span className="workspace-section-label">{trimmedQuery ? "검색 결과" : "주요 작가"}</span>
      {artists.map((artist) => <ArtistRow key={artist.id} artist={artist} current={creator === artist.id} onNavigate={onNavigate} />)}
    </div>

    {!trimmedQuery && <div className="artist-index__group">
      <span className="workspace-section-label">정리</span>
      {sectionLink("merge", "같은 작가일 수 있어요", <MergeIcon />, overview?.mergeSuggestions, section, onNavigate)}
      <button type="button" className="workspace-index-link artist-index__link" aria-current={creator !== null && isUnknownArtist(creator) ? "page" : undefined}
        aria-label={`작가 미상 ${count(overview?.unknownNone)}`} onClick={() => onNavigate({ kind: "creator", creatorKey: UNKNOWN_NONE })}>
        <span className="artist-index__icon" aria-hidden="true"><QuestionIcon /></span>
        <span className="more-panel__label">작가 미상</span>
        {overview?.unknownNone !== undefined && <span className="more-panel__count">{count(overview.unknownNone)}</span>}
        {styleSuggestionCount > 0 && <span className="artist-index__suggestion-badge" aria-label={`추천 ${count(styleSuggestionCount)}`}>
          <SparklesIcon aria-hidden="true" />추천 {count(styleSuggestionCount)}
        </span>}
      </button>
    </div>}
  </nav>;
}

function ArtistRow({ artist, current, onNavigate }: { artist: ArtistSummary; current: boolean; onNavigate: (view: AssetView) => void }) {
  return <button type="button" className="workspace-index-link artist-index__link artist-index__artist-row"
    aria-current={current ? "page" : undefined} aria-label={`${artist.label} ${count(artist.assetCount)}장`}
    onClick={() => onNavigate({ kind: "creator", creatorKey: artist.id })}>
    <span className="artist-index__thumb" aria-hidden="true">{artist.coverAssetIds[0] && <img src={thumbnailUrl(artist.coverAssetIds[0])} alt="" loading="lazy" decoding="async" draggable={false} />}</span>
    <span className="more-panel__label artist-name">{artist.label}</span>
    <span className="more-panel__count">{count(artist.assetCount)}</span>
  </button>;
}

function sectionLink(target: ArtistHubSection, label: string, icon: ReactNode, value: number | undefined, current: ArtistHubSection | null, onNavigate: (view: AssetView) => void) {
  return <button type="button" className="workspace-index-link artist-index__link" aria-current={current === target ? "page" : undefined}
    aria-label={value === undefined ? label : `${label} ${count(value)}`} onClick={() => onNavigate({ kind: "artists", section: target })}>
    <span className="artist-index__icon" aria-hidden="true">{icon}</span>
    <span className="more-panel__label">{label}</span>
    {value !== undefined && <span className="more-panel__count">{count(value)}</span>}
  </button>;
}
