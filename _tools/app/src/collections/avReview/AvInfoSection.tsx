import { CheckIcon, ChevronDownIcon, ChevronUpIcon } from "@heroicons/react/24/outline";
import type { ReactNode } from "react";
import { displayDate } from "../../shared/displayDate";
import { Badge } from "../../shared/ui/Badge";
import { Button } from "../../shared/ui/Button";
import { Checkbox } from "../../shared/ui/Checkbox";
import { FilterChip } from "../../shared/ui/FilterChip";
import { SectionLabel } from "../../shared/ui/SectionLabel";

export type InfoKey = "title_ja" | "release_date" | "maker" | "label" | "series";
export const INFO_LABELS: Record<InfoKey, string> = { title_ja: "원제", release_date: "발매일", maker: "제작사", label: "레이블", series: "시리즈" };
const INFO_KEYS: readonly InfoKey[] = ["title_ja", "release_date", "maker", "label", "series"];

export type InfoField = { key: InfoKey; candidate: string | null; current: string | null; checked: boolean };
export type InfoPerson = {
  id: string;
  nameJa: string;
  /** What the person is called here, and the Japanese name beside it when that differs. */
  primary: string;
  secondary: string | null;
  /** Already credited on the destination: nothing to decide. */
  linked: boolean;
  /** Will be created as a new person (not linked to an existing one). */
  newPerson: boolean;
  selected: boolean;
};
export type InfoGenre = { original: string; name: string; selected: boolean };
export type AvInfoModel = {
  isNew: boolean;
  fields: InfoField[];
  people: InfoPerson[];
  /** The candidate's genres worth showing (sale and distribution tags already left out). */
  genres: InfoGenre[];
  /** The destination's genres worth showing, by Korean name. */
  currentGenres: string[];
  hiddenGenres: number;
};

const has = (value: string | null | undefined) => typeof value === "string" && value.trim().length > 0;
const fieldText = (key: InfoKey, value: string | null | undefined) => key === "release_date" ? displayDate(value ?? "") : value ?? "";

type Fact = { label: string; value: ReactNode };

/** The read-only summary: everything for a new collection, only what will change for an existing one. */
export function infoFacts(model: AvInfoModel): { title: string | null; rows: Fact[]; rest: number } {
  const byKey = new Map(model.fields.map(field => [field.key, field]));
  const rows: Fact[] = [];
  const newPeople = (people: InfoPerson[]) => people.filter(person => person.newPerson).length;
  if (model.isNew) {
    const get = (key: InfoKey) => byKey.get(key)?.candidate ?? null;
    const date = get("release_date");
    if (has(date)) rows.push({ label: "발매", value: <span className="numeric">{fieldText("release_date", date)}</span> });
    const maker = [get("maker"), get("label")].filter(has).join(" · ");
    if (maker) rows.push({ label: "제작", value: <span lang="ja">{maker}</span> });
    if (has(get("series"))) rows.push({ label: "시리즈", value: <span lang="ja">{get("series")}</span> });
    if (model.people.length) {
      const fresh = newPeople(model.people);
      rows.push({ label: "출연", value: <>{model.people.map(person => person.primary).join(" · ")}{fresh > 0 && <> <Badge>{`새 인물 ${fresh}`}</Badge></>}</> });
    }
    const genres = model.genres.filter(genre => genre.selected).map(genre => genre.name);
    if (genres.length) rows.push({ label: "장르", value: genres.join(" · ") });
    return { title: get("title_ja"), rows, rest: 0 };
  }
  let rest = 0;
  for (const field of model.fields) {
    const label = field.key === "release_date" ? "발매" : field.key === "maker" ? "제작" : INFO_LABELS[field.key];
    if (field.checked && has(field.candidate)) {
      rows.push({ label, value: <span className={field.key === "release_date" ? "numeric" : undefined} lang={field.key === "release_date" ? undefined : "ja"}>{fieldText(field.key, field.candidate)}</span> });
    } else if (has(field.candidate) && has(field.current) && field.candidate !== field.current) {
      rows.push({
        label,
        value: <><span className="av-facts__old numeric">{fieldText(field.key, field.current)}</span><span className="av-facts__arrow">→</span><span className="numeric">{fieldText(field.key, field.candidate)}</span> <Badge>다름 · 그대로 둠</Badge></>,
      });
    } else if (has(field.candidate) && field.candidate === field.current) rest += 1;
  }
  const added = model.people.filter(person => !person.linked && person.selected);
  if (added.length) {
    const fresh = newPeople(added);
    rows.push({ label: "출연", value: <>+ {added.map(person => person.primary).join(" · ")}{fresh > 0 && <> <Badge>{`새 인물 ${fresh}`}</Badge></>}</> });
  }
  const adding = model.genres.filter(genre => genre.selected && !model.currentGenres.includes(genre.name)).map(genre => genre.name);
  if (adding.length) rows.push({ label: "장르", value: `+ ${adding.join(" · ")}` });
  return { title: null, rows, rest };
}

export function AvInfoSection({ model, open, onToggle, onField, onPerson, onGenre, personControls, disabled = false }: {
  model: AvInfoModel;
  open: boolean;
  onToggle(): void;
  onField(key: InfoKey, checked: boolean): void;
  onPerson(id: string, selected: boolean): void;
  onGenre(original: string): void;
  /** The client's own controls for one person: an editable name and the link to an existing person. */
  personControls(person: InfoPerson): { name?: ReactNode; link?: ReactNode };
  disabled?: boolean;
}) {
  const title = model.isNew ? "정보" : "바뀌는 정보";
  const actions = <Button size="sm" variant="quiet" aria-expanded={open} onClick={onToggle}>{open ? "접기" : "자세히"}{open ? <ChevronUpIcon aria-hidden="true" /> : <ChevronDownIcon aria-hidden="true" />}</Button>;
  if (!open) {
    const facts = infoFacts(model);
    return <section className="av-side__section" aria-label={title}>
      <SectionLabel title={title} actions={actions} />
      <div className="av-facts">
        {facts.title && <p className="av-facts__title" lang="ja">{facts.title}</p>}
        {facts.rows.map(row => <div className="av-facts__row" key={row.label}><span className="av-facts__label">{row.label}</span><span className="av-facts__value">{row.value}</span></div>)}
        {!model.isNew && facts.rows.length === 0 && <p className="av-facts__rest">바뀌는 정보 없음</p>}
        {facts.rest > 0 && <p className="av-facts__rest">같음 {facts.rest}개</p>}
      </div>
    </section>;
  }
  return <section className="av-side__section" aria-label={title}>
    <SectionLabel title={title} actions={actions} />
    <div className="av-fields">
      {model.fields.map(field => {
        const same = !model.isNew && has(field.current) && field.current === field.candidate;
        const badge = model.isNew ? null : same ? "같음" : has(field.current) ? "다름" : "빈 칸";
        const kind = field.key === "release_date" ? { className: "numeric" } : { lang: "ja" };
        return <label className={`av-field${field.checked ? "" : " is-off"}`} key={field.key}>
          <Checkbox aria-label={`${INFO_LABELS[field.key]} 적용`} checked={field.checked} disabled={disabled || !has(field.candidate) || same} onChange={event => onField(field.key, event.target.checked)} />
          <span className="av-field__label">{INFO_LABELS[field.key]}</span>
          <span className="av-field__value">
            <span {...kind}>{has(field.candidate) ? fieldText(field.key, field.candidate) : "후보 없음"}</span>
            {!model.isNew && <small>지금 <span {...kind}>{has(field.current) ? fieldText(field.key, field.current) : "—"}</span> {has(field.candidate) && badge && <Badge>{badge}</Badge>}</small>}
          </span>
        </label>;
      })}
    </div>
    {model.people.length > 0 && <>
      <SectionLabel title="출연" count={model.people.length} />
      <div className="av-people">
        {model.people.map(person => {
          if (person.linked) return <div className="av-person is-linked" key={person.id}>
            <span className="av-person__check" aria-hidden="true"><CheckIcon /></span>
            <span className="av-person__name"><span>{person.primary}</span><small lang="ja">{[person.secondary ?? person.nameJa, "이미 연결됨"].filter(Boolean).join(" · ")}</small></span>
          </div>;
          const controls = personControls(person);
          return <div className="av-person" key={person.id}>
            <Checkbox aria-label={`${person.nameJa} 넣기`} checked={person.selected} disabled={disabled} onChange={event => onPerson(person.id, event.target.checked)} />
            <span className="av-person__name">{controls.name ?? <span>{person.primary}</span>}<small lang="ja">{person.secondary ?? person.nameJa}</small></span>
            {controls.link}
          </div>;
        })}
      </div>
    </>}
    {(model.genres.length > 0 || model.hiddenGenres > 0) && <>
      <SectionLabel title="장르" count={model.genres.length} />
      <div className="av-genres">
        {model.genres.map(genre => <FilterChip key={genre.original} className="av-genre" aria-pressed={genre.selected} disabled={disabled} title={genre.name === genre.original ? undefined : genre.original} onClick={() => onGenre(genre.original)}>{genre.name}</FilterChip>)}
      </div>
      {model.hiddenGenres > 0 && <p className="av-genres__hidden">판매·샘플 태그 {model.hiddenGenres}개 숨김</p>}
    </>}
  </section>;
}

export { INFO_KEYS };
