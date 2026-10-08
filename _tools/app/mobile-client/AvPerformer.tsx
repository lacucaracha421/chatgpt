import {useEffect, useMemo, useState} from 'react';
import {ArrowsUpDownIcon, PencilIcon, Squares2X2Icon, StarIcon} from '@heroicons/react/24/outline';
import {StarIcon as StarSolidIcon} from '@heroicons/react/24/solid';
import {CollectionList} from '../src/collections/CollectionList';
import {ProfileRows, ProfileLinks} from '../src/collections/av/AvPerformerProfile';
import type {AvPerformerProfile} from '../src/collections/avTypes';
import {displayDate} from '../src/shared/displayDate';
import {Badge, Button, Dialog, DialogDescription, EmptyState, IconButton, SectionLabel, SegmentedControl, Skeleton} from './ui';
import {PersonPortrait, performersOf} from './AvCollections';
import {ShelfTile, viewKey, type ShelfView} from './CollectionShelf';
import {AvPerformerLibraryStats} from '../src/collections/av/AvPerformerLibraryStats';
import {allWorks} from './collectionReleasesModel';
import {api, ApiError, errorText, native} from './transport';
import {AuthorityQueue} from './CollectionAuthorityForms';
import {clearPersonNotice, confirmedPerson, optimisticPerson, personCommand, personNotice, reconcilePerson} from './collectionCommandOutbox';
import {normalizePersonMemo, personMemoLength, PERSON_MEMO_LIMIT, PERSON_MEMO_TOO_LONG, type PersonFields, type PersonValues} from './avEditModel';
import type {useCollectionAuthority} from './useCollectionAuthority';
import {personPath, personReply, type AvPerson, type CollectionPerson, type CollectionPersonProfile, type CollectionSummary} from './collectionModel';

type RoleFilter = 'all' | 'solo' | 'joint';
type ReleaseOrder = 'newest' | 'oldest';
type PerformerShelf = {works: CollectionSummary[]; revision: string};
type Authority = ReturnType<typeof useCollectionAuthority>;
/** The person read: `readAt` is when the read began, so acknowledgements after it ask for another read. */
type PersonRead = {id: string; person: CollectionPerson | null; readAt: number};

/** 내 메모 for a performer (PC: the memo editor on the performer page), as the tablet's memo sheet. */
function PersonMemoSheet({initial, onClose, onSave}: {initial: string; onClose(): void; onSave(value: string): void}) {
  const [draft, setDraft] = useState(initial);
  const length = personMemoLength(draft), over = length > PERSON_MEMO_LIMIT;
  return <Dialog open title="내 메모" onClose={onClose}><DialogDescription className="sr-only">이 배우에 대한 메모를 씁니다. PC와 함께 씁니다.</DialogDescription>
    <div className="library-sheet collection-memo-sheet">
      <textarea aria-label="배우 메모" value={draft} onChange={event => setDraft(event.target.value)} rows={8}/>
      <p className={`collection-memo-counter numeric${over ? ' is-over' : ''}`} aria-live="polite">{length.toLocaleString()} / {PERSON_MEMO_LIMIT.toLocaleString()}</p>
      {over && <p role="alert">{PERSON_MEMO_TOO_LONG}</p>}
      <Button variant="primary" disabled={over} onClick={() => onSave(draft)}>저장</Button>
      <Button variant="ghost" onClick={onClose}>취소</Button>
    </div>
  </Dialog>;
}

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
/** Where the PC's representative image came from, as the PC performer page words it. */
function portraitSourceText(person: CollectionPerson, crop: AvPerson['portraitCrop'], works: CollectionSummary[]) {
  const portrait = person.portrait;
  if (!portrait) return null;
  if (portrait.source === 'stashdb') return 'StashDB';
  if (portrait.source === 'commons') return `Wikimedia Commons · ${portrait.author ?? '저작자 미상'} · ${portrait.license ?? '라이선스 미상'}`;
  const work = crop ? works.find(item => item.artworkVersions?.[crop.artworkId]) : undefined;
  return `표지에서 자름 · ${work?.av?.productCode ?? work?.name ?? '앞표지'}`;
}

/** Only the performer page starts at six; a saved AV view choice still takes precedence. */
export function avPerformerView(view: ShelfView): ShelfView {
  try {
    const saved = JSON.parse(localStorage.getItem(viewKey('av')) ?? 'null');
    if (Number.isInteger(saved?.perRow)) return view;
  } catch { /* Use the performer default when storage is unavailable. */ }
  return {...view, perRow: 6};
}

/**
 * The AV performer page (PC `AvPerformerPage`), from what the server publishes: a portrait and identity row
 * with shared profile facts and compact library statistics, then the memo and the
 * works on the shared shelf (역할, 정렬, 보기), 자주 함께 나온 배우 and 레이블. An upgraded server
 * also publishes the person (`/v1/collections/people/{id}`): the favourite mark, the portrait's
 * source, the StashDB profile rows and links, and 내 메모. With the collection authority active,
 * 즐겨찾기 and 내 메모 are edited here through `setPerson` (optimistic, queued in the command
 * outbox); otherwise they stay read-only. On a 404 (an older server or PC) those parts are simply absent. The page waits for that reply, and a switch to another
 * performer keeps the shown page (inert) until the next one is ready, so nothing pops in.
 */
export function AvPerformerScreen({personId, currentId, active, privacy, perRow, onOpen, onPerformer, onSort, onView, order, authority}: {
  personId: string; currentId: string | null; active: boolean; privacy: boolean; perRow: number; order: ReleaseOrder; authority?: Authority;
  onOpen(id: string, order: string[]): void; onPerformer(id: string): void; onSort(): void; onView(): void;
}) {
  const [shelf, setShelf] = useState<PerformerShelf | null>(null), [error, setError] = useState(''), [attempt, setAttempt] = useState(0);
  const [role, setRole] = useState<RoleFilter>('all'), [picked, setPicked] = useState<string | null>(null);
  // The published person of `id`; null when the server has none (404, an older server) or the read failed.
  const [person, setPerson] = useState<PersonRead | null>(null);
  const [memoOpen, setMemoOpen] = useState(false), [editError, setEditError] = useState('');
  // This device's latest acknowledged change to the shown person: a read that began before it is re-read.
  const acknowledged = Math.max(0, ...(authority?.acknowledgements ?? []).map(row => row.command.commandType === 'setPerson' && row.command.personId === personId ? row.acceptedAt ?? 0 : 0));
  const stale = person?.id === personId && acknowledged >= person.readAt;
  useEffect(() => {
    if (!active || person?.id === personId && !stale) return;
    const controller = new AbortController(), readAt = Date.now(), again = stale;
    // A re-read keeps the shown person on a failure; only a definite 404 removes it.
    void api<unknown>(personPath(personId), controller.signal).then(reply => personReply(reply, personId),
      reason => again && !(reason instanceof ApiError && reason.status === 404) ? undefined : null).then(value => {
      if (controller.signal.aborted || value === undefined) return;
      setPerson({id: personId, person: value, readAt});
    });
    return () => controller.abort();
  }, [active, personId, person?.id, stale]);
  useEffect(() => { setMemoOpen(false); setEditError(''); }, [personId]);
  const identity = authority?.identity;
  const read = person?.id === personId ? person.person : null;
  useEffect(() => {
    if (identity && read && person) reconcilePerson(identity, personId, {memo: normalizePersonMemo(read.memo), favorite: read.favorite === true}, person.readAt);
  }, [identity, read, person, personId]);
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
      dates: works.map(work => work.av?.releaseDate ?? work.releaseDate).filter((date): date is string => !!date).sort(),
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
  const profile = published?.profile ? sharedProfile(published.id, published.profile) : null;
  // 즐겨찾기 and 내 메모 are edited only against a confirmed server person with the authority active;
  // the shown values are that person with this device's acknowledged and queued changes over it.
  const editable = !!identity && !!published && !waiting;
  const confirmed: PersonValues | null = published && authority ? confirmedPerson({memo: normalizePersonMemo(published.memo), favorite: published.favorite === true}, shownId, authority.acknowledgements) : null;
  const values: PersonValues | null = confirmed && authority ? optimisticPerson(confirmed, shownId, authority.rows) : null;
  const refused = !!authority?.rows.some(row => row.state === 'conflict' && row.command.commandType === 'setPerson' && row.command.personId === shownId);
  const memo = values ? values.memo : published?.memo?.trim();
  const notice = personNotice(shownId);
  const save = (desired: PersonFields) => {
    if (!editable || !authority || !confirmed || refused) return false;
    try {
      const command = personCommand(shownId, confirmed, authority.rows, desired);
      if (command) authority.enqueue(command, page.person!.name);
      setEditError(''); return true;
    } catch (reason) { setEditError(errorText(reason)); return false; }
  };
  return <article className="tablet-performer" aria-label="AV 배우" aria-busy={waiting} inert={waiting || undefined}>
    <header className="tablet-performer__band">
      <div className="tablet-performer__portrait" title={source ? `사진 출처: ${source}` : undefined}>
        <PersonPortrait person={page.person} current={page.works[0]!} items={shelf!.works} revision={shelf!.revision} size="large"/>
      </div>
      <div className="tablet-performer__identity">
        <div className="tablet-performer__title"><h1>{page.person.name}{!editable && published?.favorite && <span className="tablet-performer__favorite" role="img" aria-label="즐겨찾기한 배우"><StarSolidIcon aria-hidden="true"/></span>}</h1>
          {editable && values && <IconButton pop className="tablet-performer__favorite-toggle" label={values.favorite ? '즐겨찾기 해제' : '즐겨찾기'} icon={StarIcon} activeIcon={StarSolidIcon} active={values.favorite}
            disabled={refused} onClick={() => save({favorite: !values.favorite})}/>}</div>
        {page.person.nameJa && <p lang="ja">{page.person.nameJa}</p>}
        <section className="tablet-performer__facts" aria-label="프로필 정보">
          {profile && <ProfileRows profile={profile}/>}
          {profile && <ProfileLinks key={shownId} profile={profile} openLink={url => native('openExternal', {url}).then(() => {})}/>}
        </section>
        <AvPerformerLibraryStats workCount={page.works.length} soloCount={page.works.filter(page.solo).length} firstRelease={page.dates[0] ?? null} lastRelease={page.dates[page.dates.length - 1] ?? null} averageScore={page.average}/>
      </div>
    </header>
    {editable ? <section className="tablet-performer__memo" aria-label="내 메모">
      <SectionLabel title="메모" actions={<Button size="icon" variant="ghost" aria-label="배우 메모 편집" disabled={refused} onClick={() => setMemoOpen(true)}><PencilIcon aria-hidden="true"/></Button>}/>
      <button type="button" className="tablet-performer__memo-text" disabled={refused} onClick={() => setMemoOpen(true)}>{memo || <span className="tablet-performer__memo-empty">메모 쓰기</span>}</button>
    </section> : memo && <section className="tablet-performer__memo" aria-label="내 메모"><SectionLabel title="메모"/><p>{memo}</p></section>}
    {(editable || notice) && <div className="tablet-performer__edits">
      {editable && <AuthorityQueue authority={authority!} personId={shownId} onForm={() => {}}/>}
      {refused && <p className="tablet-performer__edit-note">충돌을 정리한 뒤 다시 편집할 수 있습니다.</p>}
      {editError && <p role="alert">{editError}</p>}
      {notice && <div className="inline-error" role="alert"><span>{notice}</span><Button variant="ghost" onClick={() => clearPersonNotice(shownId)}>닫기</Button></div>}
    </div>}
    {memoOpen && editable && <PersonMemoSheet initial={memo ?? ''} onClose={() => setMemoOpen(false)} onSave={value => { if (save({memo: value})) setMemoOpen(false); }}/>}
    <section className="tablet-performer__works" aria-labelledby="tablet-performer-works">
      <div className="tablet-performer__tools">
        <h2 id="tablet-performer-works">작품 <span className="numeric">{shown.length.toLocaleString()}</span></h2>
        <div className="tablet-performer__controls">
          <SegmentedControl label="역할" value={role} onChange={setRole} options={[{value: 'all', label: '전체'}, {value: 'solo', label: '단독'}, {value: 'joint', label: '공동 출연'}]}/>
          <IconButton label="정렬" icon={ArrowsUpDownIcon} onClick={onSort}/>
          <IconButton label="보기" icon={Squares2X2Icon} onClick={onView}/>
        </div>
      </div>
      <CollectionList items={shown} view={{layout: 'shelf', perRow, grouping: 'sort'}} label="배우 작품 선반" onPick={setPicked} windowRows pickedId={picked}
        render={work => <ShelfTile item={work} revision={shelf!.revision} active={active} privacy={privacy} picked={picked === work.id} onTap={tap}
          extra={<><span className="tablet-performer__code"><b>{work.av?.productCode ?? work.name}</b></span><small className="numeric">{[displayDate(work.av?.releaseDate ?? work.releaseDate), page.solo(work) ? null : '공동 출연', work.id === currentId ? '이 작품' : null].filter(Boolean).join(' · ')}</small></>}/>}/>
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
