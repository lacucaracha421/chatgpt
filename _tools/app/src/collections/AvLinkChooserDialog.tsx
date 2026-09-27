import { ArrowTopRightOnSquareIcon, ArrowUturnLeftIcon, ChevronRightIcon, ExclamationTriangleIcon, XMarkIcon } from "@heroicons/react/24/outline";
import { openUrl } from "@tauri-apps/plugin-opener";
import { useCallback, useEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type PointerEvent } from "react";
import { workArtworkThumbnailUrl } from "../assets/mediaUrl";
import type { CollectionSummary } from "../library/types";
import { usePrivacy } from "../privacy/PrivacyContext";
import { Button } from "../shared/ui/Button";
import { Dialog } from "../shared/ui/Dialog";
import { Select } from "../shared/ui/Select";
import { TextField } from "../shared/ui/TextField";
import { avGateway } from "./avClient";
import type { AvGateway, AvPerson } from "./avTypes";
import { avLinkClient, type AvLinkApplyRequest, type AvLinkCandidate, type AvLinkFields, type AvLinkPersonChoice, type AvLinkPersonMatch, type AvLinkSurfaceChoice } from "./avLinkClient";

type Surface = "front" | "spine" | "back";
type FieldKey = "title_ja" | "release_date" | "maker" | "label" | "series";
type PersonDraft = { action: "skip" | "link" | "new"; personId?: string; displayName: string };
type AvLinkApi = typeof avLinkClient;

const FIELD_ROWS: Array<{ key: FieldKey; label: string }> = [
  { key: "title_ja", label: "원제" },
  { key: "release_date", label: "발매일" },
  { key: "maker", label: "제작사" },
  { key: "label", label: "레이블" },
  { key: "series", label: "시리즈" },
];
const SURFACES: Array<{ key: Surface; label: string }> = [
  { key: "front", label: "앞표지" },
  { key: "spine", label: "책등" },
  { key: "back", label: "뒷표지" },
];

export function AvLinkChooserDialog({ inboxId, collections, api = avLinkClient, peopleApi = avGateway, onClose, onApplied, onDismissed }: {
  inboxId: string;
  collections: CollectionSummary[];
  api?: AvLinkApi;
  peopleApi?: Pick<AvGateway, "searchPeople">;
  onClose(): void;
  onApplied(collectionId: string): void | Promise<void>;
  onDismissed(): void | Promise<void>;
}) {
  const { privacyMode } = usePrivacy();
  const [candidate, setCandidate] = useState<AvLinkCandidate | null>(null);
  const [targetId, setTargetId] = useState<string | undefined>(undefined);
  const [showPicker, setShowPicker] = useState(false);
  const [newName, setNewName] = useState("");
  const [split, setSplit] = useState({ x1: 1, x2: 2 });
  const [surfaces, setSurfaces] = useState<Record<Surface, AvLinkSurfaceChoice>>({ front: "candidate", spine: "candidate", back: "candidate" });
  const [fieldChecks, setFieldChecks] = useState<Record<FieldKey, boolean>>({ title_ja: false, release_date: false, maker: false, label: false, series: false });
  const [peopleChecks, setPeopleChecks] = useState({ performers: false, directors: false, genres: false });
  const [genres, setGenres] = useState<Set<string>>(new Set());
  const [performers, setPerformers] = useState<Record<string, PersonDraft>>({});
  const [directors, setDirectors] = useState<Record<string, PersonDraft>>({});
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const jacketRef = useRef<HTMLDivElement>(null);

  const resetFromCandidate = useCallback((next: AvLinkCandidate) => {
    const isNew = !next.current;
    const normalizedSplit = next.defaultSplit.isWrap ? clampSplit(next.defaultSplit.x1, next.defaultSplit.x2, next.jacketWidth) : { x1: 0, x2: 0 };
    setSplit(normalizedSplit);
    setNewName(isNew ? next.inbox.normalizedCode || next.inbox.productCode : "");
    setSurfaces(Object.fromEntries(SURFACES.map(({ key }) => {
      const currentId = next.current?.covers[`${key}Id`];
      if (!next.defaultSplit.isWrap && key !== "front") return [key, currentId ? "keep" : "clear"];
      if (key === "spine" && !next.defaultSplit.useSpine) return [key, currentId ? "keep" : "clear"];
      return [key, isNew || !currentId ? "candidate" : "keep"];
    })) as Record<Surface, AvLinkSurfaceChoice>);
    setFieldChecks(Object.fromEntries(FIELD_ROWS.map(({ key }) => [key, hasValue(next.fields[key]) && (isNew || !hasValue(next.current?.fields[key]))])) as Record<FieldKey, boolean>);
    setPeopleChecks({
      performers: next.performers.some(person => !person.alreadyLinked),
      directors: next.directors.some(person => !person.alreadyLinked),
      genres: Boolean(next.fields.genres?.length) && (isNew || !next.current?.fields.genres?.length),
    });
    setGenres(new Set(next.fields.genres ?? []));
    setPerformers(personDrafts(next.performers));
    setDirectors(personDrafts(next.directors));
  }, []);

  const load = useCallback(async (destination?: string) => {
    setLoading(true); setError(null);
    try {
      const next = await api.getCandidate(inboxId, destination);
      setCandidate(next);
      setTargetId(next.current?.collectionId);
      resetFromCandidate(next);
    } catch (reason) {
      setError(errorMessage(reason, "후보를 불러오지 못했습니다."));
    } finally { setLoading(false); }
  }, [api, inboxId, resetFromCandidate]);
  useEffect(() => { void load(); }, [load]);

  const isNew = Boolean(candidate && !candidate.current);
  const spinePercent = candidate ? ((split.x2 - split.x1) / candidate.jacketWidth) * 100 : 0;
  const spineWarning = Boolean(candidate?.defaultSplit.isWrap) && (spinePercent < 1 || spinePercent > 12);

  function moveLine(line: "x1" | "x2", delta: number) {
    if (!candidate) return;
    setSplit(current => line === "x1"
      ? { ...current, x1: Math.max(1, Math.min(current.x2 - 1, current.x1 + delta)) }
      : { ...current, x2: Math.min(candidate.jacketWidth - 1, Math.max(current.x1 + 1, current.x2 + delta)) });
  }
  function setLine(line: "x1" | "x2", x: number) {
    if (!candidate) return;
    setSplit(current => line === "x1"
      ? { ...current, x1: Math.max(1, Math.min(current.x2 - 1, Math.round(x))) }
      : { ...current, x2: Math.min(candidate.jacketWidth - 1, Math.max(current.x1 + 1, Math.round(x))) });
  }
  function lineKeyDown(line: "x1" | "x2", event: KeyboardEvent<HTMLButtonElement>) {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    moveLine(line, (event.shiftKey ? 10 : 1) * (event.key === "ArrowLeft" ? -1 : 1));
  }
  function beginDrag(line: "x1" | "x2", event: PointerEvent<HTMLButtonElement>) {
    if (!candidate) return;
    event.preventDefault();
    event.currentTarget.focus();
    const move = (next: globalThis.PointerEvent) => {
      const rect = jacketRef.current?.getBoundingClientRect();
      if (!rect || rect.width <= 0) return;
      setLine(line, ((next.clientX - rect.left) / rect.width) * candidate.jacketWidth);
    };
    const stop = () => { window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", stop); };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", stop, { once: true });
  }

  async function chooseTarget(collectionId: string) {
    setShowPicker(false);
    await load(collectionId || undefined);
  }
  async function apply() {
    if (!candidate) return;
    setBusy(true); setError(null);
    const fields: AvLinkFields = {};
    for (const { key } of FIELD_ROWS) if (fieldChecks[key]) fields[key] = candidate.fields[key] ?? null;
    if (peopleChecks.genres) fields.genres = [...genres];
    const requestBase = {
      split,
      surfaces,
      fields,
      performers: peopleChecks.performers ? peopleRequest(candidate.performers, performers) : [],
      directors: peopleChecks.directors ? peopleRequest(candidate.directors, directors) : [],
    };
    const request: AvLinkApplyRequest = candidate.current
      ? { ...requestBase, collectionId: candidate.current.collectionId, expectedRevision: candidate.current.covers.revision }
      : { ...requestBase, newCollectionName: newName.trim() || candidate.inbox.normalizedCode || candidate.inbox.productCode };
    try {
      const result = await api.apply(inboxId, request);
      await onApplied(result.collectionId);
    } catch (reason) {
      const message = errorMessage(reason, "후보를 적용하지 못했습니다.");
      if (isStale(reason)) {
        await load(targetId);
        setError(message);
      } else setError(message);
    } finally { setBusy(false); }
  }
  async function dismiss() {
    if (!window.confirm("가져온 후보를 거절할까요? 이 후보는 삭제되며 되돌릴 수 없습니다.")) return;
    setBusy(true); setError(null);
    try { await api.dismiss(inboxId); await onDismissed(); }
    catch (reason) { setError(errorMessage(reason, "후보를 거절하지 못했습니다.")); }
    finally { setBusy(false); }
  }

  const coverChanges = Object.values(surfaces).filter(value => value !== "keep" && value !== "clear").length
    + Object.entries(surfaces).filter(([key, value]) => value === "clear" && Boolean(candidate?.current?.covers[`${key as Surface}Id`])).length;
  const infoChanges = Object.values(fieldChecks).filter(Boolean).length + Object.values(peopleChecks).filter(Boolean).length;
  const title = isNew ? "새 AV 컬렉션으로 만들기" : "후보 확인";

  return <Dialog open title={title} variant="workspace" onClose={() => { if (!busy) onClose(); }}>
    <div className="av-link-chooser">
      <header className="av-link-chooser__header">
        <div className="av-link-chooser__heading"><h2>{title}{candidate && <span className="av-link-code">{candidate.inbox.normalizedCode || candidate.inbox.productCode}</span>}</h2>
          {candidate && (isNew
            ? <p>이 품번과 맞는 AV 컬렉션이 없어요. <button type="button" onClick={() => setShowPicker(value => !value)}>기존 컬렉션에 연결…</button></p>
            : <p>적용할 컬렉션 <b>{candidate.current?.name}</b><span> · AV{candidate.current?.fields.release_date && <> · <span className="numeric">{candidate.current.fields.release_date.slice(0, 4)}</span></>}</span> <button type="button" onClick={() => setShowPicker(value => !value)}>다른 컬렉션 선택</button></p>)}
          {showPicker && <Select label="연결할 AV 컬렉션" value={targetId ?? ""} onChange={event => void chooseTarget(event.target.value)}>
            {isNew && <option value="">새 AV 컬렉션으로 만들기</option>}
            {collections.map(collection => <option key={collection.id} value={collection.id}>{collection.name}</option>)}
          </Select>}
        </div>
        {candidate && <div className="av-link-chooser__source"><span>출처 <b>LibreDMM</b> · <span className="numeric">{clockTime(candidate.inbox.fetchedAt || candidate.inbox.receivedAt)}</span> 조회</span>{candidate.inbox.sourceUrl && <Button size="sm" variant="ghost" onClick={() => void openUrl(candidate.inbox.sourceUrl!)}>원본 페이지 열기<ArrowTopRightOnSquareIcon aria-hidden="true" /></Button>}</div>}
        <Button size="icon" variant="ghost" aria-label="후보 창 닫기" disabled={busy} onClick={onClose}><XMarkIcon aria-hidden="true" /></Button>
      </header>
      {loading && <p className="av-link-chooser__loading" role="status">후보를 불러오는 중…</p>}
      {!loading && candidate && <div className="av-link-chooser__body">
        <section className="av-link-chooser__cover" aria-labelledby="av-link-cover-title">
          <SectionHeading id="av-link-cover-title" title="표지" note="펼친 재킷 · 선을 끌어 뒤 | 옆 | 앞 나누기" />
          <div ref={jacketRef} className="av-link-jacket" style={{ aspectRatio: `${candidate.jacketWidth} / ${candidate.jacketHeight}` }}>
            {!privacyMode && <img src={candidate.jacketUrl} alt="펼친 재킷 후보" draggable={false} />}
            {privacyMode && <span className="av-link-jacket__privacy">비공개 모드</span>}
            <SplitZone label="뒤" left={0} width={split.x1} total={candidate.jacketWidth} pixels={split.x1} />
            <SplitZone label="옆" left={split.x1} width={split.x2 - split.x1} total={candidate.jacketWidth} />
            <SplitZone label="앞" left={split.x2} width={candidate.jacketWidth - split.x2} total={candidate.jacketWidth} pixels={candidate.jacketWidth - split.x2} />
            {candidate.defaultSplit.isWrap && <>
              <button type="button" role="slider" className="av-link-split" style={{ left: `${(split.x1 / candidate.jacketWidth) * 100}%` }}
                aria-label="뒤와 옆 사이 선" aria-valuemin={1} aria-valuemax={split.x2 - 1} aria-valuenow={split.x1}
                onPointerDown={event => beginDrag("x1", event)} onKeyDown={event => lineKeyDown("x1", event)} />
              <button type="button" role="slider" className="av-link-split" style={{ left: `${(split.x2 / candidate.jacketWidth) * 100}%` }}
                aria-label="옆과 앞 사이 선" aria-valuemin={split.x1 + 1} aria-valuemax={candidate.jacketWidth - 1} aria-valuenow={split.x2}
                onPointerDown={event => beginDrag("x2", event)} onKeyDown={event => lineKeyDown("x2", event)} />
            </>}
          </div>
          <div className="av-link-jacket__meta">
            <span>원본 <b className="numeric">{candidate.jacketWidth} × {candidate.jacketHeight}</b></span>
            <span>책등 <b className="numeric">{split.x2 - split.x1}px · {spinePercent.toFixed(1)}%</b></span>
            {spineWarning && <span className="av-link-jacket__warning"><ExclamationTriangleIcon aria-hidden="true" />책등이 너무 넓거나 좁아요 — 선을 확인하세요</span>}
            {candidate.defaultSplit.isWrap && <Button size="sm" variant="ghost" onClick={() => setSplit(clampSplit(candidate.defaultSplit.x1, candidate.defaultSplit.x2, candidate.jacketWidth))}><ArrowUturnLeftIcon aria-hidden="true" />자동 추정으로</Button>}
          </div>
          <div className="av-link-surfaces">{SURFACES.map(({ key, label }) => {
            const bounds = cropBounds(key, split, candidate.jacketWidth);
            const currentId = candidate.current?.covers[`${key}Id`] ?? null;
            return <section key={key} className="av-link-surface" aria-label={label}>
              <h4>{label}<small className="numeric">{bounds.width} × {candidate.jacketHeight}</small></h4>
              <div className="av-link-surface__pair">
                <ArtworkBox label="지금" url={currentId ? workArtworkThumbnailUrl(currentId) : null} privacy={privacyMode} />
                <ChevronRightIcon aria-hidden="true" />
                <CropBox candidate={candidate} x={bounds.x} width={bounds.width} privacy={privacyMode} choice={surfaces[key]} />
              </div>
              <div className="av-link-segment" role="group" aria-label={`${label} 선택`}>{([
                ["candidate", "후보 사용"], ["keep", "유지"], ["clear", "비우기"],
              ] as const).map(([value, text]) => <button key={value} type="button" aria-pressed={surfaces[key] === value}
                disabled={(value === "keep" && !currentId) || (value === "candidate" && bounds.width < 1)} onClick={() => setSurfaces(current => ({ ...current, [key]: value }))}>{text}</button>)}</div>
            </section>;
          })}</div>
        </section>
        <section className="av-link-chooser__info" aria-labelledby="av-link-info-title">
          <SectionHeading id="av-link-info-title" title="정보" note={`체크한 항목만 ${isNew ? "들어갑니다" : "바뀝니다"}`} />
          {isNew && <div className="av-link-new-name"><TextField label="새 컬렉션 이름" maxLength={4000} value={newName} onChange={event => setNewName(event.target.value)} />
            <Button onClick={() => setNewName(candidate.fields.title_ja?.trim() || candidate.inbox.normalizedCode || candidate.inbox.productCode)}>원제로 채우기</Button></div>}
          <MetadataDiff candidate={candidate} isNew={isNew} checks={fieldChecks} onCheck={(key, value) => setFieldChecks(current => ({ ...current, [key]: value }))}
            peopleChecks={peopleChecks} onPeopleCheck={(key, value) => setPeopleChecks(current => ({ ...current, [key]: value }))}
            performers={performers} directors={directors} onPerformers={setPerformers} onDirectors={setDirectors} genres={genres} onGenres={setGenres} peopleApi={peopleApi} />
        </section>
      </div>}
      {error && <p className="av-link-chooser__error" role="alert">{error}</p>}
      <footer className="av-link-chooser__footer">
        <Button variant="ghost" className="av-link-chooser__reject" disabled={busy || !candidate} onClick={() => void dismiss()}>거절</Button>
        <span className="av-link-chooser__footer-spacer" />
        {candidate && <span className="av-link-chooser__summary">표지 <b className="numeric">{coverChanges}</b>면 · 정보 <b className="numeric">{infoChanges}</b>개 바뀜</span>}
        <Button disabled={busy} onClick={onClose}>나중에</Button>
        <Button variant="primary" disabled={busy || loading || !candidate || (isNew && !newName.trim())} onClick={() => void apply()}>{isNew ? "새 컬렉션 만들기" : "적용"}</Button>
      </footer>
    </div>
  </Dialog>;
}

function SectionHeading({ id, title, note }: { id: string; title: string; note: string }) {
  return <div className="av-link-section-heading"><h3 id={id}>{title}</h3><span>{note}</span></div>;
}

function SplitZone({ label, left, width, total, pixels }: { label: string; left: number; width: number; total: number; pixels?: number }) {
  return <span className="av-link-zone" style={{ left: `${(left / total) * 100}%`, width: `${(width / total) * 100}%` }}><b>{label}</b>{pixels !== undefined && <small className="numeric">{pixels}px</small>}</span>;
}

function ArtworkBox({ label, url, privacy }: { label: string; url: string | null; privacy: boolean }) {
  return <div className="av-link-art-box"><div>{url && !privacy ? <img src={url} alt="현재 표지" /> : <span>{privacy ? "비공개" : "없음"}</span>}</div><small>{label}</small></div>;
}

function CropBox({ candidate, x, width, privacy, choice }: { candidate: AvLinkCandidate; x: number; width: number; privacy: boolean; choice: AvLinkSurfaceChoice }) {
  if (width < 1) return <div className="av-link-art-box"><div className="av-link-crop"><span>후보 없음</span></div><small>후보</small></div>;
  const style = { "--crop-image-width": `${(candidate.jacketWidth / width) * 100}%`, "--crop-image-left": `${(-x / width) * 100}%`, aspectRatio: `${width} / ${candidate.jacketHeight}` } as CSSProperties;
  return <div className="av-link-art-box"><div className="av-link-crop" style={style}>{!privacy && <img src={candidate.jacketUrl} alt="후보 표지 자르기" draggable={false} />}
    {choice !== "candidate" && <span>{choice === "keep" ? "지금 것 유지" : "비움"}</span>}</div><small>후보</small></div>;
}

function MetadataDiff({ candidate, isNew, checks, onCheck, peopleChecks, onPeopleCheck, performers, directors, onPerformers, onDirectors, genres, onGenres, peopleApi }: {
  candidate: AvLinkCandidate;
  isNew: boolean;
  checks: Record<FieldKey, boolean>;
  onCheck(key: FieldKey, value: boolean): void;
  peopleChecks: { performers: boolean; directors: boolean; genres: boolean };
  onPeopleCheck(key: "performers" | "directors" | "genres", value: boolean): void;
  performers: Record<string, PersonDraft>;
  directors: Record<string, PersonDraft>;
  onPerformers(value: Record<string, PersonDraft>): void;
  onDirectors(value: Record<string, PersonDraft>): void;
  genres: Set<string>;
  onGenres(value: Set<string>): void;
  peopleApi: Pick<AvGateway, "searchPeople">;
}) {
  return <div className={`av-link-diff${isNew ? " is-new" : ""}`} role="table" aria-label="후보 정보 비교">
    <div className="av-link-diff__head" role="row"><span /><b role="columnheader">항목</b>{!isNew && <b className="av-link-diff__current" role="columnheader">지금</b>}<b role="columnheader">LibreDMM</b></div>
    {FIELD_ROWS.map(({ key, label }) => {
      const current = candidate.current?.fields[key] ?? null;
      const next = candidate.fields[key] ?? null;
      const same = !isNew && hasValue(current) && valuesEqual(current, next);
      const different = !isNew && hasValue(current) && hasValue(next) && !same;
      const disabled = !hasValue(next) || same;
      return <div className={`av-link-diff__row${checks[key] ? "" : " is-off"}`} role="row" key={key}>
        <input type="checkbox" aria-label={`${label} 적용`} checked={checks[key]} disabled={disabled} onChange={event => onCheck(key, event.target.checked)} />
        <b role="cell">{label}</b>{!isNew && <span className="av-link-diff__current" role="cell">{fieldDisplay(key, current)}</span>}
        <span role="cell" className="av-link-diff__candidate">{fieldDisplay(key, next)}{same && <em>같음</em>}{different && <em className="is-different">다름</em>}</span>
      </div>;
    })}
    <PeopleRow label="출연" checked={peopleChecks.performers} isNew={isNew} current={currentPeople(candidate, "performer")}
      people={candidate.performers} drafts={performers} onCheck={value => onPeopleCheck("performers", value)} onDrafts={onPerformers} peopleApi={peopleApi} />
    <PeopleRow label="감독" checked={peopleChecks.directors} isNew={isNew} current={currentPeople(candidate, "director")}
      people={candidate.directors} drafts={directors} onCheck={value => onPeopleCheck("directors", value)} onDrafts={onDirectors} peopleApi={peopleApi} />
    <div className={`av-link-diff__row av-link-diff__row--rich${peopleChecks.genres ? "" : " is-off"}`} role="row">
      <input type="checkbox" aria-label="장르 적용" checked={peopleChecks.genres} disabled={!candidate.fields.genres?.length} onChange={event => onPeopleCheck("genres", event.target.checked)} />
      <b role="cell">장르</b>{!isNew && <span className="av-link-diff__current" role="cell">{candidate.current?.fields.genres?.join(" · ") || "—"}</span>}
      <span role="cell" className="av-link-genres">{candidate.fields.genres?.length ? candidate.fields.genres.map(genre => <button key={genre} type="button" aria-pressed={genres.has(genre)} onClick={() => {
        const next = new Set(genres); if (next.has(genre)) next.delete(genre); else next.add(genre); onGenres(next);
      }}>{genre}</button>) : "후보 없음"}</span>
    </div>
  </div>;
}

function PeopleRow({ label, checked, isNew, current, people, drafts, onCheck, onDrafts, peopleApi }: {
  label: string;
  checked: boolean;
  isNew: boolean;
  current: string;
  people: AvLinkPersonMatch[];
  drafts: Record<string, PersonDraft>;
  onCheck(value: boolean): void;
  onDrafts(value: Record<string, PersonDraft>): void;
  peopleApi: Pick<AvGateway, "searchPeople">;
}) {
  return <div className={`av-link-diff__row av-link-diff__row--rich${checked ? "" : " is-off"}`} role="row">
    <input type="checkbox" aria-label={`${label} 적용`} checked={checked} disabled={!people.some(person => !person.alreadyLinked)} onChange={event => onCheck(event.target.checked)} />
    <b role="cell">{label}</b>{!isNew && <span className="av-link-diff__current" role="cell">{current}</span>}
    <span role="cell" className="av-link-people">{people.length === 0 ? "후보 없음" : people.map(person => {
      const draft = drafts[person.name_ja] ?? defaultPersonDraft(person);
      const name = personLabel(person);
      return <span className="av-link-person" key={person.name_ja}><span className="av-link-person__name"><b>{name}</b>{person.alreadyLinked && <small>이미 연결됨</small>}</span>
        {!person.alreadyLinked && <PersonChoiceControl person={person} draft={draft} peopleApi={peopleApi}
          onChange={value => onDrafts({ ...drafts, [person.name_ja]: value })} />}
      </span>;
    })}</span>
  </div>;
}

function PersonChoiceControl({ person, draft, peopleApi, onChange }: {
  person: AvLinkPersonMatch;
  draft: PersonDraft;
  peopleApi: Pick<AvGateway, "searchPeople">;
  onChange(value: PersonDraft): void;
}) {
  const name = personLabel(person);
  const [searching, setSearching] = useState(false);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<AvPerson[]>([]);
  useEffect(() => {
    if (!searching || !query.trim()) { setResults([]); return; }
    let live = true;
    const timer = window.setTimeout(() => {
      void peopleApi.searchPeople(query.trim()).then(value => { if (live) setResults(value); }, () => { if (live) setResults([]); });
    }, 180);
    return () => { live = false; window.clearTimeout(timer); };
  }, [peopleApi, query, searching]);
  return <>
    <select aria-label={`${name} 연결 방식`} value={searching ? "search" : draft.action === "link" ? `link:${draft.personId}` : draft.action} onChange={event => {
      const value = event.target.value;
      if (value === "search") { setSearching(true); setQuery(person.name_ko || person.name_ja); return; }
      setSearching(false);
      onChange(value.startsWith("link:") ? { ...draft, action: "link", personId: value.slice(5) } : { ...draft, action: "new", personId: undefined });
    }}>
      {person.personId && <option value={`link:${person.personId}`}>{person.displayName || name}</option>}
      {draft.action === "link" && draft.personId && draft.personId !== person.personId && <option value={`link:${draft.personId}`}>{draft.displayName}</option>}
      <option value="new">새 인물로 추가</option>
      <option value="search">기존 인물에 연결…</option>
    </select>
    {searching && <span className="av-link-person__search"><input autoFocus aria-label={`${name} 기존 인물 검색`} maxLength={120} value={query} onChange={event => setQuery(event.target.value)} />
      {results.length > 0 && <span role="listbox" aria-label={`${name} 기존 인물 검색 결과`}>{results.map(result => <button type="button" role="option" key={result.id} onClick={() => {
        onChange({ action: "link", personId: result.id, displayName: result.displayName }); setSearching(false);
      }}>{result.displayName}</button>)}</span>}</span>}
    {!searching && draft.action === "new" && <input aria-label={`${name} 표시 이름`} maxLength={120} value={draft.displayName} onChange={event => onChange({ ...draft, displayName: event.target.value })} />}
  </>;
}

function clampSplit(x1: number, x2: number, width: number) {
  if (width < 3) return { x1: 0, x2: width };
  const first = Math.max(1, Math.min(width - 2, Math.round(x1)));
  return { x1: first, x2: Math.max(first + 1, Math.min(width - 1, Math.round(x2))) };
}

function cropBounds(surface: Surface, split: { x1: number; x2: number }, width: number) {
  if (surface === "back") return { x: 0, width: split.x1 };
  if (surface === "spine") return { x: split.x1, width: split.x2 - split.x1 };
  return { x: split.x2, width: width - split.x2 };
}

function personDrafts(people: AvLinkPersonMatch[]) {
  return Object.fromEntries(people.map(person => [person.name_ja, defaultPersonDraft(person)]));
}

function defaultPersonDraft(person: AvLinkPersonMatch): PersonDraft {
  if (person.alreadyLinked) return { action: "skip", personId: person.personId ?? undefined, displayName: person.displayName || person.name_ko || person.name_ja };
  if (person.personId) return { action: "link", personId: person.personId, displayName: person.displayName || person.name_ko || person.name_ja };
  return { action: "new", displayName: person.name_ko || person.name_ja };
}

function peopleRequest(people: AvLinkPersonMatch[], drafts: Record<string, PersonDraft>): AvLinkPersonChoice[] {
  return people.flatMap<AvLinkPersonChoice>(person => {
    const draft = drafts[person.name_ja] ?? defaultPersonDraft(person);
    if (person.alreadyLinked || draft.action === "skip") return [];
    if (draft.action === "link" && draft.personId) return [{ name_ja: person.name_ja, action: "link" as const, personId: draft.personId }];
    const displayName = draft.displayName.trim();
    return displayName ? [{ name_ja: person.name_ja, action: "new" as const, displayName }] : [];
  });
}

function personLabel(person: AvLinkPersonMatch) {
  return person.name_ko ? `${person.name_ko} (${person.name_ja})` : person.name_ja;
}

function currentPeople(candidate: AvLinkCandidate, role: "performer" | "director") {
  return candidate.current?.people.filter(person => person.role === role).map(person => person.creditName || person.displayName).join(" · ") || "—";
}

function fieldDisplay(key: FieldKey, value: string | null | undefined) {
  if (!value) return <span className="av-link-dash">—</span>;
  return key === "release_date" ? value.replace(/-/g, ".") : value;
}

function hasValue(value: unknown) {
  return Array.isArray(value) ? value.length > 0 : typeof value === "string" ? value.trim().length > 0 : value !== null && value !== undefined;
}

function valuesEqual(left: unknown, right: unknown) {
  return Array.isArray(left) && Array.isArray(right) ? left.length === right.length && left.every((value, index) => value === right[index]) : left === right;
}

function isStale(reason: unknown) {
  return typeof reason === "object" && reason !== null && "code" in reason && reason.code === "av_stale";
}

function clockTime(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "--:--";
  return new Intl.DateTimeFormat("ko-KR", { hour: "2-digit", minute: "2-digit", hour12: false }).format(date);
}

function errorMessage(reason: unknown, fallback: string) {
  if (reason instanceof Error) return reason.message.trim() || fallback;
  if (typeof reason === "object" && reason && "message" in reason && typeof reason.message === "string") return reason.message.trim() || fallback;
  return typeof reason === "string" && reason.trim() ? reason.trim() : fallback;
}
