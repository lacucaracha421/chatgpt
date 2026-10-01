import type { CollectionSummary, CollectionWorkRecord, CollectionRecordEdit, TmdbConnection } from "../../library/types";
import type { AvDetails, AvRelated } from "../avTypes";
import { displayDate } from "../../shared/displayDate";
import { Button } from "../../shared/ui/Button";
import { Badge } from "../../shared/ui/Badge";
import { WorkRecordEditor, RecordStars, defaultRecord, statusLabel } from "./WorkRecord";
import { SectionLabel } from "../../shared/ui/SectionLabel";
import { AvPortrait } from "../av/AvPortrait";
import { CaseFacts, type Fact } from "../case/CollectionCase";
import { FilmDetails } from "../FilmDetails";
import { SeriesSeasons } from "../SeriesSeasons";
import { displayGenres } from "../displayGenres";

export function workFacts(collection: CollectionSummary, av: AvDetails | null): Fact[] {
  const rows = collection.type === "av" ? [
    ["품번", av?.productCode], ["메이커", av?.maker], ["레이블", av?.label],
    ["발매", displayDate(av?.releaseDate || collection.releaseDate)], ["태그", av?.genres.join(" · ")],
  ] : collection.type === "movie" ? [["감독", collection.director], ["제작사", collection.productionCompany], ["개봉", displayDate(collection.releaseDate)], ["러닝타임", collection.runtimeMinutes ? `${collection.runtimeMinutes}분` : null], ["장르", displayGenres(collection.genres)]] : collection.type === "manga" ? [["작가", collection.author], ["연도", collection.year?.toString()], ["출판사", collection.publisher], ["발매", displayDate(collection.releaseDate)]] : [["개발사", collection.developer], ["배급사", collection.publisher], ["발매", displayDate(collection.releaseDate)], ["플랫폼", collection.platforms], ["장르", displayGenres(collection.genres)]];
  return rows.filter(row => Boolean(row[1])).map(([label, value]) => [label!, label === "장르" || label === "태그" ? <span className="work-badges">{(label === "태그" ? av?.genres ?? [] : String(value).split(/\s*[,·]\s*/)).map((genre, index) => <Badge key={`${genre}/${index}`}>{genre}</Badge>)}</span> : value!] as Fact);
}
export function workRecord(collection: CollectionSummary, record = defaultRecord(collection)): Fact[] {
  return [["들인 날", displayDate(collection.createdAt)], ["상태", statusLabel(collection.type, record.status)], ["별점", <RecordStars score={record.myScore} />], ...(collection.type === "game" ? [["기기", record.ownedPlatform ?? "미입력"] as Fact] : [])];
}
export function insideFacts(collection: CollectionSummary, av: AvDetails | null): Fact[] {
  const labels = collection.type === "av" ? ["품번", "메이커", "발매"] : collection.type === "movie" ? ["감독", "개봉", "러닝타임"] : ["개발사", "발매"];
  return workFacts(collection, av).filter(([label]) => labels.includes(label));
}
export function insideRecord(collection: CollectionSummary, record: CollectionWorkRecord): Fact[] {
  return workRecord(collection, record).filter(([label]) => label !== "들인 날");
}
export function WorkInfo({ collection, av, related, tmdb, record = defaultRecord(collection), onSave, onOpenPerson, onOpenCollection, onCopyCode }: {
  collection: CollectionSummary; av: AvDetails | null; related: AvRelated | null; tmdb?: TmdbConnection | null;
  record?: CollectionWorkRecord; onSave(edit: CollectionRecordEdit): Promise<CollectionWorkRecord>;
  onOpenPerson(id: string): void; onOpenCollection?(id: string): void; onCopyCode(): void;
}) {
  const groups = related ? [
    ...related.performers.map(person => ({ name: `${person.displayName} · 다른 작품`, items: person.items })),
    ...(related.series ? [{ name: "같은 시리즈", items: related.series.items }] : []),
    ...(related.label ? [{ name: "같은 레이블", items: related.label.items }] : []),
  ] : [];
  return <div className="work-info">
    <WorkRecordEditor collection={collection} record={record} onSave={onSave} />
    <section><SectionLabel title="작품 정보" /><CaseFacts rows={workFacts(collection, av)} />
      <CaseFacts rows={([
        ["원제", collection.originalTitle], ["시리즈", av?.series], ["수록", collection.type !== "movie" && collection.runtimeMinutes ? `${collection.runtimeMinutes}분` : null],
        ...(tmdb?.series ? [["방영 상태", tmdb.series.status], ["최근 방영", displayDate(tmdb.series.lastAirDate)]] : []),
        ["외부 평점", collection.externalScore === null ? null : `${collection.externalScore}`],
      ]).filter(row => Boolean(row[1])) as Fact[]} />
      {av?.productCode && <Button size="sm" variant="quiet" onClick={onCopyCode}>품번 복사</Button>}
    </section>
    {collection.type === "movie" && collection.overview?.trim() && <section aria-label="개요"><SectionLabel title="개요" /><p className="work-overview">{collection.overview}</p></section>}
    {collection.type === "movie" && (tmdb?.series ? <SeriesSeasons key={collection.id} series={tmdb.series} /> : tmdb?.mediaType !== "tv" && tmdb?.film ? <FilmDetails key={collection.id} film={tmdb.film} onOpenCollection={onOpenCollection} /> : null)}
    {av && av.people.length > 0 && <section><SectionLabel title="출연 · 감독" /><div className="work-people">{av.people.map(person => <Button key={`${person.role}/${person.id}`} variant="ghost" onClick={() => onOpenPerson(person.id)} className="work-person"><AvPortrait portrait={person.portrait} name={person.displayName} size={40} /><span><b>{person.displayName}</b><small>{person.role === "director" ? "감독" : [person.nameJa, `내 라이브러리 ${person.workCount}편`].filter(Boolean).join(" · ")}</small>{person.creditName && <small>{person.creditName}</small>}</span></Button>)}</div></section>}
    {groups.some(group => group.items.length > 0) && <details><summary>관련 작품</summary>{groups.filter(group => group.items.length > 0).map(group => <section key={group.name}><SectionLabel title={group.name} />{group.items.map(item => <Button key={item.collectionId} variant="quiet" onClick={() => onOpenCollection?.(item.collectionId)}>{item.productCode ?? item.name} · {displayDate(item.releaseDate)}</Button>)}</section>)}</details>}
  </div>;
}
