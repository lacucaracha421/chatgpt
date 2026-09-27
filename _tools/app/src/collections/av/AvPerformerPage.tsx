import { ArrowTopRightOnSquareIcon, ChevronLeftIcon, PencilIcon } from "@heroicons/react/24/outline";
import { useEffect, useMemo, useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { displayDate } from "../../shared/displayDate";
import { Button } from "../../shared/ui/Button";
import { usePrivacy } from "../../privacy/PrivacyContext";
import { avError } from "../avClient";
import type { AvGateway, AvPerformerPage as PerformerData, AvWorkCard } from "../avTypes";
import { AvPortrait } from "./AvPortrait";
import { AvPortraitPicker } from "./AvPortraitPicker";
import { DvdCase } from "./DvdCase";
import "./avPerformerPage.css";

type WorkFilter = "all" | "solo" | "joint";
type WorkSort = "newest" | "oldest";

export function AvPerformerPage({ personId, currentCollectionId, api, onBack, onOpenCollection, onOpenPerformer }: {
  personId: string; currentCollectionId?: string; api: AvGateway; onBack(): void; onOpenCollection?: (collectionId: string) => void; onOpenPerformer?: (personId: string) => void;
}) {
  const { privacyMode } = usePrivacy();
  const [page, setPage] = useState<PerformerData | null>(null);
  const [filter, setFilter] = useState<WorkFilter>("all");
  const [sort, setSort] = useState<WorkSort>("newest");
  const [pickerOpen, setPickerOpen] = useState(false);
  const [memoEditing, setMemoEditing] = useState(false);
  const [memo, setMemo] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    setPage(null); setError(null); setMemoEditing(false);
    void api.getPerformer(personId).then(value => { if (active) { setPage(value); setMemo(value.person.memo ?? ""); } }, reason => { if (active) setError(avError(reason)); });
    return () => { active = false; };
  }, [api, personId]);

  const works = useMemo(() => {
    if (!page) return [];
    return page.works.filter(work => filter === "all" || (filter === "solo" ? work.solo : !work.solo)).slice().sort((left, right) => compareRelease(left.releaseDate, right.releaseDate, sort));
  }, [filter, page, sort]);

  async function saveMemo() {
    if (!page) return;
    setBusy(true); setError(null);
    try {
      const saved = await api.savePersonMemo(personId, memo.trim() || null);
      setPage(saved); setMemo(saved.person.memo ?? ""); setMemoEditing(false);
    } catch (reason) { setError(avError(reason)); }
    finally { setBusy(false); }
  }

  if (error) return <article className="av-performer-page" aria-label="AV 배우 상세"><p role="alert">{error}</p><Button onClick={onBack}>작품으로 돌아가기</Button></article>;
  if (!page) return <article className="av-performer-page" aria-label="AV 배우 상세"><p role="status">배우 정보를 불러오는 중…</p></article>;

  const source = portraitSource(page, page.works);
  return <article className="av-performer-page" aria-label="AV 배우 상세">
    <div className="av-performer-page__topline"><Button size="sm" variant="ghost" onClick={onBack}><ChevronLeftIcon aria-hidden="true" /> 작품으로 돌아가기</Button><span className="numeric">컬렉션 › AV › 배우</span></div>
    <div className="av-performer-page__layout">
      <section className="av-performer-page__identity">
        <div className="av-performer-page__portrait"><AvPortrait portrait={page.person.portrait} name={page.person.displayName} size="performer" /></div>
        <div className="av-performer-page__source-line">
          {source.label}
          {source.url && <button type="button" onClick={() => void openUrl(source.url!)} aria-label="대표 이미지 출처 열기"><ArrowTopRightOnSquareIcon aria-hidden="true" />원본</button>}
        </div>
        <Button size="sm" onClick={() => setPickerOpen(true)}>대표 이미지 바꾸기</Button>
        <h1>{page.person.displayName}</h1>
        {page.person.nameJa && <p className="av-performer-page__name-ja" lang="ja">{page.person.nameJa}</p>}
        <div className="av-performer-page__stats"><Stat value={page.stats.workCount.toLocaleString()} label="내 라이브러리 작품" /><Stat value={releaseRange(page.stats.firstRelease, page.stats.lastRelease)} label="발매 기간" /><Stat value={page.stats.averageScore === null ? "—" : page.stats.averageScore.toFixed(1)} label="내 별점 평균" /></div>
        <div className="av-performer-page__ids">{page.person.fanzaActressId && <span>FANZA <b className="numeric">{page.person.fanzaActressId}</b></span>}{page.person.wikidataId && <span>Wikidata <b className="numeric">{page.person.wikidataId}</b></span>}</div>
      </section>
      <div className="av-performer-page__content">
        <section className="av-performer-page__section" aria-labelledby="av-performer-works">
          <div className="av-performer-page__section-head"><h2 id="av-performer-works">작품</h2><span className="numeric">{works.length}</span><div className="av-performer-page__filter"><FilterButton active={filter === "all"} onClick={() => setFilter("all")}>전체</FilterButton><FilterButton active={filter === "solo"} onClick={() => setFilter("solo")}>단독</FilterButton><FilterButton active={filter === "joint"} onClick={() => setFilter("joint")}>공동 출연</FilterButton></div><Button size="sm" variant="ghost" className="av-performer-page__sort" onClick={() => setSort(value => value === "newest" ? "oldest" : "newest")} aria-label="발매일 정렬">발매일 {sort === "newest" ? "최신순" : "오래된순"}</Button></div>
          <div className="av-performer-page__works">{works.map(work => <WorkTile key={work.collectionId} work={work} privacyMode={privacyMode} current={work.collectionId === currentCollectionId} onOpenCollection={onOpenCollection} />)}</div>
        </section>
        {page.coPerformers.length > 0 && <section className="av-performer-page__section"><div className="av-performer-page__section-head"><h2>자주 함께 나온 배우</h2></div><div className="av-performer-page__co">{page.coPerformers.map(co => <button type="button" key={co.id} onClick={() => onOpenPerformer?.(co.id)} className="av-performer-page__co-card" data-person-id={co.id}><AvPortrait portrait={co.portrait} name={co.displayName} size={48} /><span><b>{co.displayName}</b><small>{co.count}편</small></span></button>)}</div></section>}
        {page.labels.length > 0 && <section className="av-performer-page__section"><div className="av-performer-page__section-head"><h2>레이블</h2></div><div className="av-performer-page__labels">{page.labels.map(label => <span key={label.name}>{label.name} <b className="numeric">{label.count}</b></span>)}</div></section>}
        <section className="av-performer-page__section av-performer-page__memo"><div className="av-performer-page__section-head"><h2>내 메모</h2>{!memoEditing && <Button size="icon" variant="ghost" aria-label="배우 메모 편집" onClick={() => setMemoEditing(true)}><PencilIcon aria-hidden="true" /></Button>}</div>{memoEditing ? <><textarea aria-label="배우 메모" maxLength={2000} value={memo} onChange={event => setMemo(event.target.value)} /><div><Button size="sm" onClick={() => setMemoEditing(false)}>취소</Button><Button size="sm" variant="primary" disabled={busy} onClick={() => void saveMemo()}>저장</Button></div></> : <p>{page.person.memo || "메모 쓰기"}</p>}</section>
      </div>
    </div>
    {pickerOpen && <AvPortraitPicker personId={page.person.id} personName={page.person.displayName} wikidataId={page.person.wikidataId} api={api} onClose={() => setPickerOpen(false)} onSaved={portrait => { setPage(value => value ? { ...value, person: { ...value.person, portrait } } : value); setPickerOpen(false); }} />}
  </article>;
}

function Stat({ value, label }: { value: string; label: string }) { return <div><b className="numeric">{value}</b><span>{label}</span></div>; }
function FilterButton({ active, onClick, children }: { active: boolean; onClick(): void; children: string }) { return <button type="button" className={active ? "is-selected" : ""} aria-pressed={active} onClick={onClick}>{children}</button>; }
function releaseRange(first: string | null, last: string | null) {
  const start = displayDate(first), end = displayDate(last);
  return start && end ? `${start}–${end}` : start || end || "—";
}
function compareRelease(left: string | null, right: string | null, sort: WorkSort) {
  if (!left && !right) return 0;
  if (!left) return 1;
  if (!right) return -1;
  const result = left.localeCompare(right);
  return sort === "newest" ? -result : result;
}

function WorkTile({ work, current, privacyMode, onOpenCollection }: { work: AvWorkCard & { role: "performer" | "director"; solo: boolean }; current: boolean; privacyMode: boolean; onOpenCollection?: (collectionId: string) => void }) {
  return <button type="button" className={`av-performer-page__work${current ? " is-current" : ""}`} onClick={() => onOpenCollection?.(work.collectionId)} aria-label={`${work.name}${work.productCode ? ` ${work.productCode}` : ""}`}>
    <DvdCase frontArtworkId={work.frontArtworkId} spineArtworkId={work.spineArtworkId} backArtworkId={work.backArtworkId} revision={work.coverRevision} size={124} interactive={false} />
    <b>{work.productCode ?? work.name}</b><span>{displayDate(work.releaseDate)}</span>{current && <em>이 작품</em>}
    {privacyMode && <span className="av-performer-page__privacy-label">비공개</span>}
  </button>;
}

function portraitSource(page: PerformerData, works: PerformerData["works"]) {
  const portrait = page.person.portrait;
  if (!portrait) return { label: "대표 이미지 없음", url: null as string | null };
  if (portrait.kind === "commons") return { label: `Wikimedia Commons · ${portrait.author ?? "저작자 미상"} · ${portrait.license ?? "라이선스 미상"}`, url: portrait.sourceUrl };
  const work = works.find(candidate => candidate.frontArtworkId === portrait.artworkId);
  return { label: `표지에서 자름 · ${work?.productCode ?? work?.name ?? "앞표지"}`, url: null };
}
