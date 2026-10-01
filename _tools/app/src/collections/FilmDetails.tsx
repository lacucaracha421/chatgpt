import { useId, useState } from "react";
import { tmdbImagePreviewUrl } from "../assets/mediaUrl";
import type { TmdbFilmData } from "../library/types";
import { usePrivacy } from "../privacy/PrivacyContext";
import { SectionLabel } from "../shared/ui/SectionLabel";
import { Badge } from "../shared/ui/Badge";
import { displayDate } from "../shared/displayDate";
import { Button } from "../shared/ui/Button";

const countryNames: Record<string, string> = {
  KR: "한국", US: "미국", JP: "일본", GB: "영국", FR: "프랑스", DE: "독일",
  CA: "캐나다", AU: "호주", CN: "중국", HK: "홍콩", TW: "대만",
};
const releaseTypes: Record<number, string> = {
  1: "프리미어", 2: "제한 개봉", 3: "극장 개봉", 4: "디지털", 5: "실물 매체", 6: "TV",
};

export function FilmDetails({ film, onOpenCollection }: { film: TmdbFilmData; onOpenCollection?: (collectionId: string) => void }) {
  const { privacyMode } = usePrivacy();
  const [allReleases, setAllReleases] = useState(false);
  const [failedPosters, setFailedPosters] = useState<Set<string>>(() => new Set());
  const releaseListId = useId();
  const releases = [...film.releases].sort((a, b) => a.date.localeCompare(b.date));
  const visibleReleases = allReleases ? releases : releases.filter((row, index) => row.country === "KR" || index === 0);
  const parts = [...(film.related?.parts ?? [])].sort((a, b) =>
    Number(Boolean(b.localCollectionId)) - Number(Boolean(a.localCollectionId))
    || (a.releaseDate ?? "9999").localeCompare(b.releaseDate ?? "9999"));

  return <>
    {film.cast.length > 0 && <section className="work-film-section" aria-label="출연">
      <SectionLabel title="출연" />
      <ul className="work-film-cast">
        {film.cast.slice(0, 8).map((person, index) => <li key={index}>
          {person.name}{person.character && <span> ({person.character})</span>}
        </li>)}
      </ul>
    </section>}
    {releases.length > 0 && <section className="work-film-section" aria-label="개봉 정보">
      <div className="work-film-section-heading">
        <SectionLabel title="개봉 정보" />
        {releases.some((row, index) => row.country !== "KR" && index !== 0) &&
          <Button size="sm" variant="ghost" aria-expanded={allReleases} aria-controls={releaseListId}
            onClick={() => setAllReleases(value => !value)}>{allReleases ? "접기" : "전체 보기"}</Button>}
      </div>
      <ul id={releaseListId} className="work-film-releases">
        {visibleReleases.map((release, index) => <li key={index}>
          <time dateTime={release.date}>{displayDate(release.date)}</time>
          <span>{countryNames[release.country] ?? release.country}</span>
          <span>{releaseTypes[release.releaseType]}</span>
          {release.certification && <span>{release.certification}</span>}
        </li>)}
      </ul>
    </section>}
    {parts.length > 0 && <section className="work-film-section" aria-label="관련 작품">
      <SectionLabel title="관련 작품" />
      {film.related?.collectionName && <p className="work-film-related-subtitle">{film.related.collectionName}</p>}
      <ul className="work-film-related" tabIndex={0} aria-label="관련 작품 목록">
        {parts.map(part => {
          const content = <>
            {!privacyMode && <div className="work-film-related-poster">
              {part.posterPath && !failedPosters.has(part.posterPath)
                ? <img src={tmdbImagePreviewUrl(part.posterPath, "poster")} alt="" loading="lazy" decoding="async"
                    onError={() => setFailedPosters(previous => new Set(previous).add(part.posterPath!))} />
                : <span>포스터 없음</span>}
            </div>}
            <span>{part.title}</span>
            {part.releaseDate && <small>{part.releaseDate.slice(0, 4)}</small>}
            {part.localCollectionId && <Badge>라이브러리</Badge>}
          </>;
          const localId = part.localCollectionId;
          return <li key={part.movieId}
            className={`work-film-related-part${localId ? "" : " work-film-related-part--external"}`}>
            {localId && onOpenCollection
              ? <Button variant="quiet" className="work-film-related-open" onClick={() => onOpenCollection(localId)}>{content}</Button>
              : content}
          </li>;
        })}
      </ul>
    </section>}
  </>;
}
