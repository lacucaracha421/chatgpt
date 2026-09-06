import { useState } from "react";
import { workArtworkThumbnailUrl } from "../assets/mediaUrl";
import type { TmdbSeriesData } from "../library/types";
import { usePrivacy } from "../privacy/PrivacyContext";
import { Button } from "../shared/ui/Button";
import { WorkArtworkGallery } from "./WorkArtworkGallery";
import "./SeriesSeasons.css";

export function SeriesSeasons({ series }: { series: TmdbSeriesData }) {
  const { privacyMode } = usePrivacy();
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [page, setPage] = useState(0);
  const [posterId, setPosterId] = useState<string | null>(null);
  const selected = series.seasons.find((season) => season.id === selectedId)
    ?? series.seasons.find((season) => season.seasonNumber > 0) ?? series.seasons[0];
  const lastPage = Math.max(0, Math.ceil((selected?.episodes.length ?? 0) / 50) - 1);
  const currentPage = Math.min(page, lastPage);
  return <section className="series-seasons" aria-label="시즌과 에피소드">
    <h2>시즌</h2>
    {series.seasons.length === 0 ? <p>등록된 시즌이 없습니다.</p> : <>
      <div className="series-seasons__posters">
        {series.seasons.map((season) => <button type="button" className="series-seasons__season" key={season.id}
          aria-pressed={selected?.id === season.id} onClick={() => { setSelectedId(season.id); setPage(0); }}
          title={season.posterArtworkId ? "더블클릭 또는 Enter로 포스터 크게 보기" : undefined}
          onDoubleClick={() => { if (!privacyMode && season.posterArtworkId) setPosterId(season.posterArtworkId); }}
          onKeyDown={event => { if (event.key === "Enter" && !privacyMode && season.posterArtworkId) { event.preventDefault(); setPosterId(season.posterArtworkId); } }}>
          {season.posterArtworkId && !privacyMode
            ? <img loading="lazy" decoding="async" src={workArtworkThumbnailUrl(season.posterArtworkId)} alt="" />
            : <span className="series-seasons__placeholder" aria-hidden="true">{season.seasonNumber === 0 ? "SP" : season.seasonNumber}</span>}
          <strong>{season.name}</strong>{" "}<small>{season.episodes.length}개 에피소드</small>
        </button>)}
      </div>
      {selected && <section aria-label={`${selected.name} 에피소드`}>
        <h3>{selected.name} {selected.airDate && <small>{selected.airDate}</small>}</h3>
        {selected.overview && <p>{selected.overview}</p>}
        {selected.episodes.length === 0 ? <p>등록된 에피소드가 없습니다.</p> : <ol className="series-seasons__episodes">
          {selected.episodes.slice(currentPage * 50, (currentPage + 1) * 50).map((episode) => <li key={episode.id}>
            <span className="series-seasons__number">{episode.episodeNumber}</span>
            <details><summary>{episode.name}<small>{[episode.airDate, episode.runtimeMinutes ? `${episode.runtimeMinutes}분` : null].filter(Boolean).join(" · ")}</small></summary>
              <p>{episode.overview || "줄거리 정보가 없습니다."}</p>
            </details>
          </li>)}
        </ol>}
        {lastPage > 0 && <div className="series-seasons__paging">
          <Button size="sm" disabled={currentPage === 0} onClick={() => setPage(currentPage - 1)}>이전 에피소드</Button>
          <span>{currentPage + 1} / {lastPage + 1}</span>
          <Button size="sm" disabled={currentPage === lastPage} onClick={() => setPage(currentPage + 1)}>다음 에피소드</Button>
        </div>}
      </section>}
    </>}
    {series.cast.length > 0 && <section aria-label="주요 출연"><h3>주요 출연</h3><p>{series.cast.join(" · ")}</p></section>}
    {posterId && <WorkArtworkGallery viewerOnly initialActiveId={posterId} onClose={() => setPosterId(null)} workTitle="시즌 포스터"
      artworks={series.seasons.flatMap(season => season.posterArtworkId ? [{ id: season.posterArtworkId, kind: "cover" as const }] : [])} />}
  </section>;
}
