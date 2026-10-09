import {performerName} from "../av/performerName";
import type { CollectionSummary, CollectionWorkRecord, CollectionRecordEdit, TmdbConnection } from "../../library/types";
import type { AvDetails, AvRelated } from "../avTypes";
import { displayDate } from "../../shared/displayDate";
import { Button } from "../../shared/ui/Button";
import { WorkRecordEditor, RecordStars, defaultRecord, statusLabel } from "./WorkRecord";
import { SectionLabel } from "../../shared/ui/SectionLabel";
import { AvPortrait } from "../av/AvPortrait";
import { CaseFacts, type Fact } from "../case/CollectionCase";
import { CaseScore } from "../case/CaseInside";
import { moreWorkFacts, workFacts } from "./workFacts";
export { insideFacts, moreWorkFacts, workFacts, type WorkFactAv, type WorkFactSource } from "./workFacts";
import { FilmDetails } from "../FilmDetails";
import { withProductCodeCopy } from "./ProductCodeCopy";
import { SeriesSeasons } from "../SeriesSeasons";

export function workRecord(collection: CollectionSummary, record = defaultRecord(collection)): Fact[] {
  return [["들인 날", displayDate(collection.createdAt)], ["상태", statusLabel(collection.type, record.status)], ["내 별점", <RecordStars score={record.myScore} />], ...(collection.type === "game" ? [["기기", record.ownedPlatform ?? "미입력"] as Fact] : [])];
}
export function insideRecord(collection: CollectionSummary, record: CollectionWorkRecord): Fact[] {
  return workRecord(collection, record).filter(([label]) => label !== "들인 날").map(([label, value]) => [label, label === "내 별점" ? <CaseScore score={record.myScore} /> : value]);
}
export function WorkInfo({ collection, av, related, tmdb, record = defaultRecord(collection), onSave, onOpenPerson, onOpenCollection, onCopyCode }: {
  collection: CollectionSummary; av: AvDetails | null; related: AvRelated | null; tmdb?: TmdbConnection | null;
  record?: CollectionWorkRecord; onSave(edit: CollectionRecordEdit): Promise<CollectionWorkRecord>;
  onOpenPerson(id: string): void; onOpenCollection?(id: string): void; onCopyCode(code: string): Promise<unknown> | void;
}) {
  const groups = related ? [
    ...related.performers.map(person => ({ name: `${performerName(person).primary} · 다른 작품`, items: person.items })),
    ...(related.series ? [{ name: "같은 시리즈", items: related.series.items }] : []),
    ...(related.label ? [{ name: "같은 레이블", items: related.label.items }] : []),
  ] : [];
  return <div className="work-info">
    <WorkRecordEditor collection={collection} record={record} onSave={onSave} />
    <section><SectionLabel title="작품 정보" /><CaseFacts rows={withProductCodeCopy(workFacts(collection, av), av?.productCode, onCopyCode)} />
      <CaseFacts rows={moreWorkFacts(collection, av, tmdb?.series ?? null)} />
    </section>
    {collection.type === "movie" && collection.overview?.trim() && <section aria-label="개요"><SectionLabel title="개요" /><p className="work-overview">{collection.overview}</p></section>}
    {collection.type === "movie" && (tmdb?.series ? <SeriesSeasons key={collection.id} series={tmdb.series} /> : tmdb?.mediaType !== "tv" && tmdb?.film ? <FilmDetails key={collection.id} film={tmdb.film} onOpenCollection={onOpenCollection} /> : null)}
    {av && av.people.length > 0 && <section><SectionLabel title="출연 · 감독" /><div className="work-people">{av.people.map(person => <Button key={`${person.role}/${person.id}`} variant="ghost" onClick={() => onOpenPerson(person.id)} className="work-person"><AvPortrait portrait={person.portrait} name={performerName(person).primary} size={40} /><span><b>{performerName(person).primary}</b>{performerName(person).secondary && <small lang="ja">{performerName(person).secondary}</small>}<small>{person.role === "director" ? "감독" : [`내 라이브러리 ${person.workCount}편`].filter(Boolean).join(" · ")}</small>{person.creditName && <small>{person.creditName}</small>}</span></Button>)}</div></section>}
    {groups.some(group => group.items.length > 0) && <details><summary>관련 작품</summary>{groups.filter(group => group.items.length > 0).map(group => <section key={group.name}><SectionLabel title={group.name} />{group.items.map(item => <Button key={item.collectionId} variant="quiet" onClick={() => onOpenCollection?.(item.collectionId)}>{item.productCode ?? item.name} · {displayDate(item.releaseDate)}</Button>)}</section>)}</details>}
  </div>;
}
