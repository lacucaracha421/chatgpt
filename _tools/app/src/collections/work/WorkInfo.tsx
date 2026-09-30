import { useEffect, useState } from "react";
import type { CollectionSummary } from "../../library/types";
import type { AvDetails, AvRelated } from "../avTypes";
import { displayDate } from "../../shared/displayDate";
import { Button } from "../../shared/ui/Button";
import { Field, TextInput } from "../../shared/ui/TextInput";
import { SectionLabel } from "../../shared/ui/SectionLabel";
import { AvPortrait } from "../av/AvPortrait";
import { CaseFacts, type Fact } from "../case/CollectionCase";
import { displayGenres } from "../displayGenres";

export function workFacts(collection: CollectionSummary, av: AvDetails | null): Fact[] {
  const rows = collection.type === "av" ? [
    ["품번", av?.productCode], ["메이커", av?.maker], ["레이블", av?.label],
    ["발매", displayDate(av?.releaseDate || collection.releaseDate)], ["태그", av?.genres.join(" · ")],
  ] : [["개발사", collection.developer], ["배급사", collection.publisher], ["발매", displayDate(collection.releaseDate)], ["플랫폼", collection.platforms], ["장르", displayGenres(collection.genres)]];
  return rows.filter((row): row is Fact => Boolean(row[1]));
}
export function workRecord(collection: CollectionSummary): Fact[] {
  return [["들인 날", displayDate(collection.createdAt)], ["별점", collection.myScore === null ? "미평가" : `${collection.myScore}/5`]];
}
export function WorkInfo({ collection, av, related, onSave, onOpenPerson, onOpenCollection, onCopyCode }: {
  collection: CollectionSummary; av: AvDetails | null; related: AvRelated | null;
  onSave(score: number | null, memo: string | null): Promise<void>;
  onOpenPerson(id: string): void; onOpenCollection?(id: string): void; onCopyCode(): void;
}) {
  const [score, setScore] = useState(collection.myScore?.toString() ?? "");
  const [memo, setMemo] = useState(collection.description ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { setScore(collection.myScore?.toString() ?? ""); setMemo(collection.description ?? ""); }, [collection.id, collection.myScore, collection.description]);
  async function save() {
    const value = score.trim() ? Number(score) : null;
    if (value !== null && (!Number.isFinite(value) || value < 0 || value > 5 || value * 2 % 1 !== 0)) { setError("별점은 0부터 5까지 0.5 단위로 입력해 주세요."); return; }
    setBusy(true); setError(null);
    try { await onSave(value, memo.trim() || null); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "저장하지 못했습니다."); }
    finally { setBusy(false); }
  }
  const groups = related ? [
    ...related.performers.map(person => ({ name: `${person.displayName} · 다른 작품`, items: person.items })),
    ...(related.series ? [{ name: "같은 시리즈", items: related.series.items }] : []),
    ...(related.label ? [{ name: "같은 레이블", items: related.label.items }] : []),
  ] : [];
  return <div className="work-info">
    <section><SectionLabel title="내 기록" /><CaseFacts rows={[["들인 날", displayDate(collection.createdAt)]]} />
      <form onSubmit={event => { event.preventDefault(); void save(); }}>
        <Field label="별점"><TextInput type="number" min={0} max={5} step={.5} value={score} onChange={event => setScore(event.target.value)} /></Field>
        <Field label="메모"><TextInput value={memo} onChange={event => setMemo(event.target.value)} /></Field>
        <Button size="sm" type="submit" disabled={busy || (score === (collection.myScore?.toString() ?? "") && memo === (collection.description ?? ""))}>저장</Button>
      </form>{error && <p role="alert">{error}</p>}
    </section>
    <section><SectionLabel title="작품 정보" /><CaseFacts rows={workFacts(collection, av)} />
      <CaseFacts rows={([
        ["원제", collection.originalTitle], ["시리즈", av?.series], ["수록", collection.runtimeMinutes ? `${collection.runtimeMinutes}분` : null],
        ["외부 평점", collection.externalScore === null ? null : `${collection.externalScore}`],
      ]).filter((row): row is Fact => Boolean(row[1]))} />
      {av?.productCode && <Button size="sm" variant="quiet" onClick={onCopyCode}>품번 복사</Button>}
    </section>
    {av && av.people.length > 0 && <section><SectionLabel title="출연 · 감독" /><div className="work-people">{av.people.map(person => <Button key={`${person.role}/${person.id}`} variant="ghost" onClick={() => onOpenPerson(person.id)} className="work-person"><AvPortrait portrait={person.portrait} name={person.displayName} size={40} /><span><b>{person.displayName}</b><small>{person.role === "director" ? "감독" : [person.nameJa, `내 라이브러리 ${person.workCount}편`].filter(Boolean).join(" · ")}</small>{person.creditName && <small>{person.creditName}</small>}</span></Button>)}</div></section>}
    {groups.some(group => group.items.length > 0) && <details><summary>관련 작품</summary>{groups.filter(group => group.items.length > 0).map(group => <section key={group.name}><SectionLabel title={group.name} />{group.items.map(item => <Button key={item.collectionId} variant="quiet" onClick={() => onOpenCollection?.(item.collectionId)}>{item.productCode ?? item.name} · {displayDate(item.releaseDate)}</Button>)}</section>)}</details>}
  </div>;
}
