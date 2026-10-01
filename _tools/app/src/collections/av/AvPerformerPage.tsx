import { ArrowTopRightOnSquareIcon, ChevronDownIcon, ChevronLeftIcon, EllipsisHorizontalIcon, PencilIcon, StarIcon } from "@heroicons/react/24/outline";
import { StarIcon as StarSolidIcon } from "@heroicons/react/24/solid";
import { useEffect, useMemo, useRef, useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { displayDate } from "../../shared/displayDate";
import { Button } from "../../shared/ui/Button";
import { libraryGateway } from "../../library/client";
import { usePrivacy } from "../../privacy/PrivacyContext";
import { avError } from "../avClient";
import type { AvGateway, AvPerformerPage as PerformerData, AvWorkCard } from "../avTypes";
import { AvPortrait } from "./AvPortrait";
import { AvPerformerProfile, safeProfileUrl } from "./AvPerformerProfile";
import { AvPortraitPicker } from "./AvPortraitPicker";
import { LightCase } from "../case/LightCase";
import { CollectionList, useCollectionView } from "../CollectionList";
import { workArtworkThumbnailUrl } from "../../assets/mediaUrl";
import { Menu } from "../../shared/ui/Menu";
import { SegmentedControl } from "../../shared/ui/SegmentedControl";
import { ViewOptionsMenu } from "../../shared/ui/ViewOptionsMenu";
import { SectionLabel } from "../../shared/ui/SectionLabel";
import { Badge } from "../../shared/ui/Badge";
import "../CollectionBrowser.css";
import "./avPerformerPage.css";

type WorkFilter = "all" | "solo" | "joint";
type WorkSort = "newest" | "oldest";

export function AvPerformerPage({ personId, currentCollectionId, api, onBack, onOpenCollection, onOpenPerformer, onOpenSettings }: {
  onOpenSettings?: () => void;
  personId: string; currentCollectionId?: string; api: AvGateway; onBack(): void; onOpenCollection?: (collectionId: string) => void; onOpenPerformer?: (personId: string) => void;
}) {
  const { privacyMode } = usePrivacy();
  const [view, updateView] = useCollectionView("av");
  const [pickedId, setPickedId] = useState<string | null>(null);
  const request = useRef(0);
  const [page, setPage] = useState<PerformerData | null>(null);
  const [filter, setFilter] = useState<WorkFilter>("all");
  const [sort, setSort] = useState<WorkSort>("newest");
  const [pickerOpen, setPickerOpen] = useState(false);
  const [memoEditing, setMemoEditing] = useState(false);
  const [memo, setMemo] = useState("");
  const [busy, setBusy] = useState(false);
  const [favorite, setFavorite] = useState<boolean | null>(null);
  const [favoriteBusy, setFavoriteBusy] = useState(false);
  const [sourceError, setSourceError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const generation = ++request.current;
    let active = true;
    setError(null); setBusy(false); setMemoEditing(false); setPickerOpen(false); setSourceError(null);
    void api.getPerformer(personId).then(value => { if (active && generation === request.current) { setPage(value); setMemo(value.person.memo ?? ""); } }, reason => { if (active) setError(avError(reason)); });
    return () => { active = false; request.current++; };
  }, [api, personId]);

  useEffect(() => {
    let active = true;
    setFavorite(null); setFavoriteBusy(false);
    void libraryGateway.listAvFavorites()
      .then(rows => { if (active) setFavorite(rows.some(row => row.id === personId)); })
      .catch(reason => { if (active) setSourceError(avError(reason)); });
    return () => { active = false; };
  }, [personId]);

  const works = useMemo(() => {
    if (!page) return [];
    return page.works.filter(work => filter === "all" || (filter === "solo" ? work.solo : !work.solo)).slice().sort((left, right) => compareRelease(left.releaseDate, right.releaseDate, sort)).map(work => ({ ...work, id: work.collectionId, type: "av" as const }));
  }, [filter, page, sort]);

  async function saveMemo() {
    if (!page) return;
    const generation = request.current;
    setBusy(true); setError(null);
    try {
      const saved = await api.savePersonMemo(personId, memo.trim() || null);
      if (generation !== request.current) return;
      setPage(saved); setMemo(saved.person.memo ?? ""); setMemoEditing(false);
    } catch (reason) { if (generation === request.current) setError(avError(reason)); }
    finally { if (generation === request.current) setBusy(false); }
  }

  async function toggleFavorite() {
    if (favorite === null || favoriteBusy) return;
    const generation = request.current;
    const next = !favorite;
    setFavoriteBusy(true); setSourceError(null);
    try {
      await libraryGateway.setAvFavorite(personId, next);
      if (generation === request.current) setFavorite(next);
    } catch (reason) { if (generation === request.current) setSourceError(avError(reason)); }
    finally { if (generation === request.current) setFavoriteBusy(false); }
  }

  if (!page) return <article className="av-performer-page" aria-label="AV 배우 상세">
    {error ? <><p role="alert">{error}</p><Button onClick={onBack}>작품으로 돌아가기</Button></> : <div className="av-performer-page__skeleton ui-skeleton" aria-label="배우 정보" aria-busy="true" />}
  </article>;

  const source = portraitSource(page, page.works);
  const stale = page.person.id !== personId;
  return <article className="av-performer-page" aria-label="AV 배우 상세">
    <div className="av-performer-page__topline">
      <Button size="icon" variant="ghost" aria-label="작품으로 돌아가기" onClick={onBack}><ChevronLeftIcon aria-hidden="true" /></Button>
      <b>{page.person.displayName}</b><span>AV › 배우</span>
      <Menu label="배우 관리" align="end" triggerClassName="av-performer-page__manage" trigger={<EllipsisHorizontalIcon aria-hidden="true" />} items={[
        { id: "portrait", label: "사진 바꾸기", onSelect: () => setPickerOpen(true), disabled: stale },
        { id: "memo", label: "메모 편집", onSelect: () => { setMemo(page.person.memo ?? ""); setMemoEditing(true); }, disabled: stale },
        ...(onOpenSettings ? [{ id: "settings", label: "설정", onSelect: onOpenSettings }] : []),
      ]} />
    </div>
    {error && <p role="alert">{error}</p>}
    <div className="av-performer-page__body" inert={stale || undefined} aria-busy={stale}>
      <header className="av-performer-page__header">
        <div className="av-performer-page__portrait"><AvPortrait portrait={page.person.portrait} name={page.person.displayName} size="performer" /></div>
        <div className="av-performer-page__identity">
          <h1>{page.person.displayName}</h1>
          {page.person.nameJa && <p className="av-performer-page__name-ja" lang="ja">{page.person.nameJa}</p>}
          <div className="av-performer-page__source-line"><span>{source.label}</span>
            {source.url && safeProfileUrl(source.url) && <Button size="sm" variant="ghost" onClick={() => void openUrl(source.url!).catch(() => setSourceError("원본 링크를 열지 못했습니다."))} aria-label="대표 이미지 출처 열기"><ArrowTopRightOnSquareIcon aria-hidden="true" />원본</Button>}
          </div>
          <div className="av-performer-page__actions">
            <Button size="icon" aria-label={favorite ? "즐겨찾기 해제" : "즐겨찾기"} aria-pressed={favorite ?? false} disabled={favorite === null || favoriteBusy} onClick={() => void toggleFavorite()}>{favorite ? <StarSolidIcon aria-hidden="true" /> : <StarIcon aria-hidden="true" />}</Button>
            <Button onClick={() => setPickerOpen(true)}>사진 바꾸기</Button>
          </div>
          {sourceError && <p className="av-profile__quiet" role="status">{sourceError}</p>}
        </div>
        <section className="av-performer-page__facts" aria-label="프로필 정보">
          <SectionLabel title="프로필" />
          <dl className="av-performer-page__summary">
            <div><dt>내 작품</dt><dd className="numeric">{page.stats.workCount.toLocaleString()}편 · 단독 {page.works.filter(work => work.solo).length}</dd></div>
            <div><dt>발매 기간</dt><dd className="numeric">{releaseRange(page.stats.firstRelease, page.stats.lastRelease)}</dd></div>
            <div><dt>별점 평균</dt><dd className="numeric">{page.stats.averageScore === null ? "—" : page.stats.averageScore.toFixed(1)}</dd></div>
            {page.person.fanzaActressId && <div><dt>FANZA</dt><dd className="numeric">{page.person.fanzaActressId}</dd></div>}
            {page.person.wikidataId && <div><dt>Wikidata</dt><dd className="numeric">{page.person.wikidataId}</dd></div>}
          </dl>
          <AvPerformerProfile displayName={page.person.displayName} nameJa={page.person.nameJa} personId={page.person.id} api={api} onOpenSettings={onOpenSettings} />
        </section>
        <section className="av-performer-page__memo" aria-label="내 메모">
          <SectionLabel title="내 메모" actions={!memoEditing && <Button size="icon" variant="ghost" aria-label="배우 메모 편집" onClick={() => { setMemo(page.person.memo ?? ""); setMemoEditing(true); }}><PencilIcon aria-hidden="true" /></Button>} />
          {memoEditing ? <><textarea className="ui-text-input" autoFocus aria-label="배우 메모" maxLength={2000} value={memo} onChange={event => setMemo(event.target.value)} /><div className="av-performer-page__memo-actions"><Button size="sm" disabled={busy} onClick={() => setMemoEditing(false)}>취소</Button><Button size="sm" variant="primary" disabled={busy} onClick={() => void saveMemo()}>저장</Button></div></> : <button type="button" className="av-performer-page__memo-text" onClick={() => { setMemo(page.person.memo ?? ""); setMemoEditing(true); }}>{page.person.memo || "메모 쓰기"}</button>}
        </section>
      </header>
      <section aria-labelledby="av-performer-works">
        <div className="av-performer-page__tools">
          <h2 id="av-performer-works">작품</h2><span className="numeric">{works.length}</span>
          <div className="av-performer-page__controls">
            <SegmentedControl label="역할" value={filter} onChange={setFilter} options={[{ value: "all", label: "전체" }, { value: "solo", label: "단독" }, { value: "joint", label: "공연" }]} />
            <Menu label="정렬" align="end" triggerClassName="asset-toolbar__quiet-menu" trigger={<>정렬 {sort === "newest" ? "최신순" : "오래된순"}<ChevronDownIcon aria-hidden="true" /></>} items={[
              { id: "newest", label: "발매일 최신순", group: "release", selected: sort === "newest", onSelect: () => setSort("newest") },
              { id: "oldest", label: "발매일 오래된순", group: "release", selected: sort === "oldest", onSelect: () => setSort("oldest") },
            ]} />
            <ViewOptionsMenu layout="shelf" options={[{ value: "shelf", label: "선반" }]} onLayoutChange={() => updateView({ layout: "shelf" })} perRow={view.perRow} min={5} max={12} onPerRowChange={perRow => updateView({ perRow })} />
          </div>
        </div>
        <CollectionList items={works} view={{ ...view, layout: "shelf" }} label="배우 작품 선반" onPick={setPickedId}
          render={work => <WorkTile work={work} privacyMode={privacyMode} selected={pickedId === work.collectionId} current={work.collectionId === currentCollectionId} onPick={setPickedId} onOpenCollection={onOpenCollection} />} />
      </section>
      <div className="av-performer-page__related">
        {page.coPerformers.length > 0 && <section><SectionLabel as="h2" title="자주 함께 나온 배우" count={page.coPerformers.length} /><div className="av-performer-page__co">{page.coPerformers.map(co => <Button variant="ghost" key={co.id} onClick={() => onOpenPerformer?.(co.id)} className="av-performer-page__co-card" aria-label={`${co.displayName} ${co.count}편`} data-person-id={co.id}><AvPortrait portrait={co.portrait} name={co.displayName} size={40} /><span><b>{co.displayName}</b><small>{co.count}편</small></span></Button>)}</div></section>}
        {page.labels.length > 0 && <section><SectionLabel as="h2" title="레이블" count={page.labels.length} /><div className="av-performer-page__labels">{page.labels.map(label => <Badge key={label.name}>{label.name} <span className="numeric">{label.count}</span></Badge>)}</div></section>}
      </div>
    </div>
    {pickerOpen && !stale && <AvPortraitPicker personId={page.person.id} personName={page.person.displayName} wikidataId={page.person.wikidataId} api={api} onClose={() => setPickerOpen(false)} onSaved={portrait => { setPage(value => value ? { ...value, person: { ...value.person, portrait } } : value); setPickerOpen(false); }} />}
  </article>;
}

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

function WorkTile({ work, current, selected, privacyMode, onPick, onOpenCollection }: { work: AvWorkCard & { solo: boolean }; current: boolean; selected: boolean; privacyMode: boolean; onPick(id: string): void; onOpenCollection?: (collectionId: string) => void }) {
  const artwork = (id: string | null) => id ? `${workArtworkThumbnailUrl(id)}?v=${encodeURIComponent(work.coverRevision)}` : null;
  return <button type="button" className="collection-card av-performer-page__work" data-collection-id={work.collectionId} aria-selected={selected} onClick={() => onPick(work.collectionId)} onDoubleClick={() => onOpenCollection?.(work.collectionId)} onKeyDown={event => {
    if (event.key === "Enter") { event.preventDefault(); onOpenCollection?.(work.collectionId); }
  }} aria-label={`${work.name}${work.productCode ? ` ${work.productCode}` : ""}`}>
    <LightCase data={{ title: work.name, platform: "av", front: artwork(work.frontArtworkId), spine: artwork(work.spineArtworkId), privacy: privacyMode }} selected={selected} />
    <span className="collection-card__meta"><span className="av-performer-page__code"><b>{work.productCode ?? work.name}</b>{current && <Badge>이 작품</Badge>}</span><span className="av-performer-page__date">{displayDate(work.releaseDate)}{!work.solo && " · 공연"}{privacyMode && " · 비공개"}</span></span>
  </button>;
}

function portraitSource(page: PerformerData, works: PerformerData["works"]) {
  const portrait = page.person.portrait;
  if (!portrait) return { label: "대표 이미지 없음", url: null as string | null };
  if (portrait.kind === "stashdb") return { label: "StashDB", url: portrait.sourceUrl };
  if (portrait.kind === "commons") return { label: `Wikimedia Commons · ${portrait.author ?? "저작자 미상"} · ${portrait.license ?? "라이선스 미상"}`, url: portrait.sourceUrl };
  const work = works.find(candidate => candidate.frontArtworkId === portrait.artworkId);
  return { label: `표지에서 자름 · ${work?.productCode ?? work?.name ?? "앞표지"}`, url: null };
}
