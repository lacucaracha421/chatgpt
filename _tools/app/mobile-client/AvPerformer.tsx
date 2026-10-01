import {useEffect, useMemo, useState} from 'react';
import {ArrowsUpDownIcon, ChevronDownIcon, Squares2X2Icon} from '@heroicons/react/24/outline';
import {CollectionList} from '../src/collections/CollectionList';
import {displayDate} from '../src/shared/displayDate';
import {Badge, Button, EmptyState, SectionLabel, SegmentedControl, Skeleton} from './ui';
import {PersonPortrait, performersOf} from './AvCollections';
import {ShelfTile} from './CollectionShelf';
import {allWorks} from './collectionReleases';
import {errorText} from './transport';
import type {AvPerson, CollectionSummary} from './collectionModel';

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
function releaseRange(dates: string[]) {
  const sorted = [...dates].sort(), first = displayDate(sorted[0]), last = displayDate(sorted[sorted.length - 1]);
  return first && last && first !== last ? `${first}–${last}` : first || last || '—';
}

/**
 * The AV performer page (PC `AvPerformerPage`), from what the server publishes: the header band
 * with the portrait, the name and the 프로필 counts derived from the published works, then the
 * works on the shared shelf (역할, 정렬, 보기), 자주 함께 나온 배우 and 레이블. The PC-only parts —
 * the 내 메모, favourite, external profile and portrait source — are not published and are left out.
 */
export function AvPerformerScreen({personId, currentId, active, privacy, perRow, onOpen, onPerformer, onSort, onView, order}: {
  personId: string; currentId: string | null; active: boolean; privacy: boolean; perRow: number; order: ReleaseOrder;
  onOpen(id: string, order: string[]): void; onPerformer(id: string): void; onSort(): void; onView(): void;
}) {
  const [shelf, setShelf] = useState<PerformerShelf | null>(null), [error, setError] = useState(''), [attempt, setAttempt] = useState(0);
  const [role, setRole] = useState<RoleFilter>('all'), [picked, setPicked] = useState<string | null>(null);
  useEffect(() => {
    if (!active) return;
    const controller = new AbortController();
    setError('');
    void allWorks('av', controller.signal).then(result => { if (!controller.signal.aborted) setShelf({works: result.works, revision: result.revision}); }, reason => { if (!controller.signal.aborted) setError(errorText(reason) || '배우 정보를 불러오지 못했습니다.'); });
    return () => controller.abort();
  }, [active, attempt]);
  const page = useMemo(() => {
    if (!shelf) return null;
    const works = shelf.works.filter(work => performersOf(work).some(person => person.id === personId));
    const person = works.flatMap(performersOf).find(entry => entry.id === personId) ?? null;
    const solo = (work: CollectionSummary) => performersOf(work).length === 1;
    const co = new Map<string, {person: AvPerson; count: number}>();
    for (const work of works) for (const other of performersOf(work)) if (other.id !== personId) co.set(other.id, {person: other, count: (co.get(other.id)?.count ?? 0) + 1});
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
  }, [shelf, personId]);
  if (!page) return <article className="tablet-performer" aria-label="AV 배우" aria-busy={!error}>
    {error ? <div className="inline-error" role="alert"><span>{error}</span><Button variant="ghost" onClick={() => setAttempt(value => value + 1)}>다시 시도</Button></div> : <Skeleton className="tablet-performer__skeleton" label="배우 정보를 불러오는 중"/>}
  </article>;
  if (!page.person) return <article className="tablet-performer" aria-label="AV 배우"><EmptyState title="이 배우의 작품이 없습니다"/></article>;
  const shown = page.works.filter(work => role === 'all' || (role === 'solo') === page.solo(work)).sort(byRelease(order));
  const tap = (id: string) => { if (picked === id) onOpen(id, shown.map(work => work.id)); else setPicked(id); };
  return <article className="tablet-performer" aria-label="AV 배우">
    <header className="tablet-performer__band">
      <PersonPortrait person={page.person} current={page.works[0]!} items={shelf!.works} revision={shelf!.revision} size="large"/>
      <div className="tablet-performer__identity"><h1>{page.person.name}</h1>{page.person.nameJa && <p lang="ja">{page.person.nameJa}</p>}</div>
      <section className="tablet-performer__facts" aria-label="프로필 정보"><SectionLabel title="프로필"/>
        <dl>
          <div><dt>내 작품</dt><dd className="numeric">{page.works.length.toLocaleString()}편 · 단독 {page.works.filter(page.solo).length.toLocaleString()}</dd></div>
          <div><dt>발매 기간</dt><dd className="numeric">{releaseRange(page.dates)}</dd></div>
          <div><dt>별점 평균</dt><dd className="numeric">{page.average === null ? '—' : page.average.toFixed(1)}</dd></div>
        </dl>
      </section>
    </header>
    <section className="tablet-performer__works" aria-labelledby="tablet-performer-works">
      <div className="collection-type-header">
        <SectionLabel as="h2" id="tablet-performer-works" title="작품" count={shown.length}/>
        <div className="filter-chips collection-chips" role="group" aria-label="정렬과 보기">
          <button className="filter-chip" onClick={onSort}><ArrowsUpDownIcon aria-hidden="true"/>{order === 'newest' ? '최신순' : '오래된순'}<ChevronDownIcon aria-hidden="true"/></button>
          <button className="filter-chip" onClick={onView}><Squares2X2Icon aria-hidden="true"/>보기<ChevronDownIcon aria-hidden="true"/></button>
        </div>
      </div>
      <SegmentedControl label="역할" value={role} onChange={setRole} options={[{value: 'all', label: '전체'}, {value: 'solo', label: '단독'}, {value: 'joint', label: '공연'}]} fullWidth/>
      <CollectionList items={shown} view={{layout: 'shelf', perRow, grouping: 'sort'}} label="배우 작품 선반" onPick={setPicked}
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
