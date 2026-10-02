import {useHorizontalWheel} from '../src/shared/ui/useHorizontalWheel';
import {useEffect, useMemo, useState} from 'react';
import {ArrowsUpDownIcon, ChevronDownIcon, Squares2X2Icon} from '@heroicons/react/24/outline';
import {StarIcon as StarSolidIcon} from '@heroicons/react/24/solid';
import {CollectionList} from '../src/collections/CollectionList';
import {ProfileRows, safeProfileUrl} from '../src/collections/av/AvPerformerProfile';
import type {AvPerformerProfile} from '../src/collections/avTypes';
import {displayDate} from '../src/shared/displayDate';
import {Badge, Button, EmptyState, SectionLabel, SegmentedControl, Skeleton} from './ui';
import {PersonPortrait, performersOf} from './AvCollections';
import {ShelfTile} from './CollectionShelf';
import {allWorks} from './collectionReleases';
import {api, errorText, native} from './transport';
import {personPath, personReply, type AvPerson, type CollectionPerson, type CollectionPersonProfile, type CollectionSummary} from './collectionModel';

type RoleFilter = 'all' | 'solo' | 'joint';
type ReleaseOrder = 'newest' | 'oldest';
type PerformerShelf = {works: CollectionSummary[]; revision: string};

/** Release order with undated works last, as on the PC performer page. */
function byRelease(order: ReleaseOrder) {
  return (left: CollectionSummary, right: CollectionSummary) => {
    const a = left.av?.releaseDate ?? left.releaseDate ?? null, b = right.av?.releaseDate ?? right.releaseDate ?? null;
    if (!a || !b) return Number(!a) - Number(!b);
    return order === 'newest' ? b.localeCompare(a) : a.localeCompare(b);
  };
}
/** The published profile as the shared PC rows read it (they read only the measurements, dates and career). */
function sharedProfile(personId: string, profile: CollectionPersonProfile): AvPerformerProfile {
  return {...profile, personId, source: 'stashdb', status: 'matched', stashdbId: null, breastType: profile.breastType as AvPerformerProfile['breastType'],
    urls: profile.urls.map(link => ({url: link.url, site: {name: link.site}})), images: [], candidates: [], fetchedAt: ''};
}
/** The profile's links, safe and once each; a tap opens the browser. */
function profileLinks(profile: CollectionPersonProfile) {
  const seen = new Set<string>();
  return profile.urls.filter(link => {
    if (!safeProfileUrl(link.url)) return false;
    const href = new URL(link.url).href;
    if (seen.has(href)) return false;
    seen.add(href); return true;
  }).map(link => ({url: link.url, label: link.site.trim() || new URL(link.url).hostname}));
}
/** Where the PC's representative image came from, as the PC performer page words it. */
function portraitSourceText(person: CollectionPerson, crop: AvPerson['portraitCrop'], works: CollectionSummary[]) {
  const portrait = person.portrait;
  if (!portrait) return null;
  if (portrait.source === 'stashdb') return 'StashDB';
  if (portrait.source === 'commons') return `Wikimedia Commons · ${portrait.author ?? '저작자 미상'} · ${portrait.license ?? '라이선스 미상'}`;
  const work = crop ? works.find(item => item.artworkVersions?.[crop.artworkId]) : undefined;
  return `표지에서 자름 · ${work?.av?.productCode ?? work?.name ?? '앞표지'}`;
}

function releaseRange(dates: string[]) {
  const sorted = [...dates].sort(), first = displayDate(sorted[0]), last = displayDate(sorted[sorted.length - 1]);
  return first && last && first !== last ? `${first}–${last}` : first || last || '—';
}

/**
 * The AV performer page (PC `AvPerformerPage`), from what the server publishes: the header band
 * with the portrait, the name and the 프로필 counts derived from the published works, then the
 * works on the shared shelf (역할, 정렬, 보기), 자주 함께 나온 배우 and 레이블. An upgraded server
 * also publishes the person (`/v1/collections/people/{id}`): the favourite mark, the portrait's
 * source, the StashDB profile rows and links, and 내 메모, all read-only. On a 404 (an older server
 * or PC) those parts are simply absent. The page waits for that reply, and a switch to another
 * performer keeps the shown page (inert) until the next one is ready, so nothing pops in.
 */
export function AvPerformerScreen({personId, currentId, active, privacy, perRow, onOpen, onPerformer, onSort, onView, order}: {
  personId: string; currentId: string | null; active: boolean; privacy: boolean; perRow: number; order: ReleaseOrder;
  onOpen(id: string, order: string[]): void; onPerformer(id: string): void; onSort(): void; onView(): void;
}) {
  const stripWheel=useHorizontalWheel();
  const [shelf, setShelf] = useState<PerformerShelf | null>(null), [error, setError] = useState(''), [attempt, setAttempt] = useState(0);
  const [role, setRole] = useState<RoleFilter>('all'), [picked, setPicked] = useState<string | null>(null);
  // The published person of `id`; null when the server has none (404, an older server) or the read failed.
  const [person, setPerson] = useState<{id: string; person: CollectionPerson | null} | null>(null);
  useEffect(() => {
    if (!active || person?.id === personId) return;
    const controller = new AbortController();
    void api<unknown>(personPath(personId), controller.signal).then(reply => personReply(reply, personId), () => null).then(value => {
      if (!controller.signal.aborted) setPerson({id: personId, person: value});
    });
    return () => controller.abort();
  }, [active, personId, person?.id]);
  // The page shows the performer whose person reply is in; a newer one waits behind it.
  const shownId = person?.id ?? personId;
  useEffect(() => {
    if (!active) return;
    const controller = new AbortController();
    setError('');
    void allWorks('av', controller.signal).then(result => { if (!controller.signal.aborted) setShelf({works: result.works, revision: result.revision}); }, reason => { if (!controller.signal.aborted) setError(errorText(reason) || '배우 정보를 불러오지 못했습니다.'); });
    return () => controller.abort();
  }, [active, attempt]);
  const page = useMemo(() => {
    if (!shelf) return null;
    const works = shelf.works.filter(work => performersOf(work).some(person => person.id === shownId));
    const person = works.flatMap(performersOf).find(entry => entry.id === shownId) ?? null;
    const solo = (work: CollectionSummary) => performersOf(work).length === 1;
    const co = new Map<string, {person: AvPerson; count: number}>();
    for (const work of works) for (const other of performersOf(work)) if (other.id !== shownId) co.set(other.id, {person: other, count: (co.get(other.id)?.count ?? 0) + 1});
    const labels = new Map<string, number>();
    for (const work of works) if (work.av?.label) labels.set(work.av.label, (labels.get(work.av.label) ?? 0) + 1);
    const scores = works.map(work => work.myScore).filter((score): score is number => typeof score === 'number');
    return {
      person, works, solo,
      dates: works.map(work => work.av?.releaseDate ?? work.releaseDate).filter((date): date is string => !!date),
      average: scores.length ? scores.reduce((sum, score) => sum + score, 0) / scores.length : null,
      coPerformers: [...co.values()].sort((a, b) => b.count - a.count || a.person.name.localeCompare(b.person.name, 'ko')),
      labels: [...labels].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'ko')),
    };
  }, [shelf, shownId]);
  if (!page || !person) return <article className="tablet-performer" aria-label="AV 배우" aria-busy={!error}>
    {error && !page ? <div className="inline-error" role="alert"><span>{error}</span><Button variant="ghost" onClick={() => setAttempt(value => value + 1)}>다시 시도</Button></div> : <Skeleton className="tablet-performer__skeleton" label="배우 정보를 불러오는 중"/>}
  </article>;
  if (!page.person) return <article className="tablet-performer" aria-label="AV 배우"><EmptyState title="이 배우의 작품이 없습니다"/></article>;
  const shown = page.works.filter(work => role === 'all' || (role === 'solo') === page.solo(work)).sort(byRelease(order));
  const tap = (id: string) => { if (picked === id) onOpen(id, shown.map(work => work.id)); else setPicked(id); };
  const published = person.person, waiting = shownId !== personId;
  const source = published && portraitSourceText(published, page.person.portraitCrop, shelf!.works);
  const links = published?.profile ? profileLinks(published.profile) : [];
  const memo = published?.memo?.trim();
  return <article className="tablet-performer" aria-label="AV 배우" aria-busy={waiting} inert={waiting || undefined}>
    <header className="tablet-performer__band">
      <PersonPortrait person={page.person} current={page.works[0]!} items={shelf!.works} revision={shelf!.revision} size="large"/>
      <div className="tablet-performer__identity">
        <h1>{page.person.name}{published?.favorite && <span className="tablet-performer__favorite" role="img" aria-label="즐겨찾기한 배우"><StarSolidIcon aria-hidden="true"/></span>}</h1>
        {page.person.nameJa && <p lang="ja">{page.person.nameJa}</p>}
        {source && <small className="tablet-performer__source">{source}</small>}
      </div>
      <section className="tablet-performer__facts" aria-label="프로필 정보"><SectionLabel title="프로필"/>
        <dl>
          <div><dt>내 작품</dt><dd className="numeric">{page.works.length.toLocaleString()}편 · 단독 {page.works.filter(page.solo).length.toLocaleString()}</dd></div>
          <div><dt>발매 기간</dt><dd className="numeric">{releaseRange(page.dates)}</dd></div>
          <div><dt>별점 평균</dt><dd className="numeric">{page.average === null ? '—' : page.average.toFixed(1)}</dd></div>
        </dl>
        {published?.profile && <ProfileRows profile={sharedProfile(published.id, published.profile)}/>}
        {links.length > 0 && <div className="tablet-performer__links" aria-label="배우 링크">{links.map(link => <Button key={link.url} variant="secondary" onClick={() => { void native('openExternal', {url: link.url}).catch(() => {}); }}>{link.label}</Button>)}</div>}
      </section>
      {memo && <section className="tablet-performer__memo" aria-label="내 메모"><SectionLabel title="내 메모"/><p>{memo}</p></section>}
    </header>
    <section className="tablet-performer__works" aria-labelledby="tablet-performer-works">
      <div className="collection-type-header">
        <SectionLabel as="h2" id="tablet-performer-works" title="작품" count={shown.length}/>
        <div ref={stripWheel} className="filter-chips collection-chips" role="group" aria-label="정렬과 보기">
          <button className="filter-chip" onClick={onSort}><ArrowsUpDownIcon aria-hidden="true"/>{order === 'newest' ? '최신순' : '오래된순'}<ChevronDownIcon aria-hidden="true"/></button>
          <button className="filter-chip" onClick={onView}><Squares2X2Icon aria-hidden="true"/>보기<ChevronDownIcon aria-hidden="true"/></button>
        </div>
      </div>
      <SegmentedControl label="역할" value={role} onChange={setRole} options={[{value: 'all', label: '전체'}, {value: 'solo', label: '단독'}, {value: 'joint', label: '공연'}]} fullWidth/>
      <CollectionList items={shown} view={{layout: 'shelf', perRow, grouping: 'sort'}} label="배우 작품 선반" onPick={setPicked} windowRows pickedId={picked}
        render={work => <ShelfTile item={work} revision={shelf!.revision} active={active} privacy={privacy} picked={picked === work.id} onTap={tap}
          extra={<>{work.id === currentId && <Badge>이 작품</Badge>}<small className="numeric">{[displayDate(work.av?.releaseDate ?? work.releaseDate), page.solo(work) ? null : '공연'].filter(Boolean).join(' · ')}</small></>}/>}/>
    </section>
    {page.coPerformers.length > 0 && <section className="tablet-performer__related" aria-label="자주 함께 나온 배우"><SectionLabel as="h2" title="자주 함께 나온 배우" count={page.coPerformers.length}/>
      <div className="tablet-performer__co">{page.coPerformers.map(({person, count}) => <Button key={person.id} variant="ghost" className="tablet-work-person" aria-label={`${person.name} ${count}편`} onClick={() => onPerformer(person.id)}>
        <PersonPortrait person={person} current={page.works[0]!} items={shelf!.works} revision={shelf!.revision}/><span><b>{person.name}</b><small className="numeric">{count.toLocaleString()}편</small></span>
      </Button>)}</div>
    </section>}
    {page.labels.length > 0 && <section className="tablet-performer__related" aria-label="레이블"><SectionLabel as="h2" title="레이블" count={page.labels.length}/>
      <div className="tablet-performer__labels">{page.labels.map(([name, count]) => <Badge key={name}>{name} <span className="numeric">{count}</span></Badge>)}</div>
    </section>}
  </article>;
}
