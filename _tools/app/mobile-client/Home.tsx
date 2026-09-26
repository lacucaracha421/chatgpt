import {useMemo, useState, useSyncExternalStore, type ComponentType, type ReactNode, type SVGProps} from 'react';
import {ArrowsUpDownIcon, BookOpenIcon, CalendarDaysIcon, ChartBarIcon, CheckCircleIcon, ChevronRightIcon, DocumentTextIcon, ListBulletIcon, LockClosedIcon, RectangleStackIcon, ServerStackIcon, SignalSlashIcon, WalletIcon} from '@heroicons/react/24/outline';
import {PinIcon} from './PinIcon';
import {Artwork} from './Collections';
import {collectionCover} from './collectionModel';
import {localToday} from './collectionReleases';
import {currentShelf, subscribeReleases} from './releaseStore';
import {addedToday, agoLabel, characterTagging, clockLabel, dateBlock, daysAfter, PENDING_LIMIT, TODO_LABELS, UPCOMING_DAYS, useHomeDashboard, useHomeMemos, type MemoRow, type TodoKey} from './homeDashboard';
import type {CharacterIndex} from './characterModel';
import type {ExchangeSnapshot} from './exchange';
import type {Asset} from './types';
import './home.css';

export interface HomeProps {
  /** The first page of recent saves (newest first): only counted for 오늘 추가, never shown. */
  items:Asset[]; hasMore:boolean;
  /** The pending captures, or null before the first read. */
  captures:Asset[]|null;
  busy:boolean; paused:boolean; secondaryError:string;
  /** The connection the offline snapshot belongs to. */
  scope:string;
  exchange:ExchangeSnapshot|null;
  /** The character index the App already holds (자산 현황's 캐릭터 자동 태그). */
  characters?:CharacterIndex|null;
  /** Character review (only when the library supports it) and similarity review, with the keys that re-read their counts. */
  review:{enabled:boolean;refreshKey:unknown}; similarityKey:unknown;
  onPending():void; onReview():void; onSimilarity():void; onDuplicates():void; onExchange():void;
  onReleases():void; onWork(id:string):void; onSettings():void;
  /** The recent saves list, and the Library root (캐릭터 자동 태그). */
  onRecent():void; onLibrary():void;
  /** Notes, optionally opening one note. */
  onNotes(id?:string):void;
  /** 다시 연결: re-read the page behind Home as well. */
  onRefresh?():void;
}

type Icon = ComponentType<SVGProps<SVGSVGElement>>;
const grouped = (amount:number) => `${amount < 0 ? '−' : ''}${String(Math.trunc(Math.abs(amount))).replace(/\B(?=(\d{3})+(?!\d))/g,',')}`;

function Stale({at}:{at:number|null|undefined}) {
  return at ? <span className="home-stale numeric">{clockLabel(at)} 기준</span> : null;
}
function Ok({children}:{children:ReactNode}) {
  return <><CheckCircleIcon className="home-ok" aria-hidden="true"/><span>{children}</span></>;
}

/**
 * One dashboard card: a header row that opens the card's screen, then its rows. A card with
 * nothing to act on is calm: only the header, with a one-line summary.
 */
function Card({icon:IconType,title,sum,calm,at,onOpen,label,className = '',children}:{icon:Icon;title:string;sum?:ReactNode;calm?:ReactNode;at?:number|null;onOpen():void;label?:string;className?:string;children?:ReactNode}) {
  const quiet = !children;
  return <section className={`home-card${quiet ? ' is-calm' : ''} ${className}`} aria-label={title}>
    <button className="home-card-head" onClick={onOpen} aria-label={label}>
      <IconType className="home-card-icon" aria-hidden="true"/><h3>{title}</h3>{sum}
      {calm && <span className="home-calm">{calm}</span>}
      <span className="home-space"/>
      <Stale at={at}/>
      <ChevronRightIcon className="home-chev" aria-hidden="true"/>
    </button>
    {children && <div className="home-card-body">{children}</div>}
  </section>;
}
function Sum({value,unit,plain}:{value:ReactNode;unit:string;plain?:boolean}) {
  return <span className={`home-sum numeric${plain ? ' is-plain' : ''}`}>{value}<small>{unit}</small></span>;
}
/** A number-first row: the figure, its meaning right beside it, then ›. */
function Row({value,unit,title,note,onOpen,label,stat,children}:{value:ReactNode;unit?:string;title:string;note?:ReactNode;onOpen():void;label?:string;stat?:boolean;children?:ReactNode}) {
  return <button className={`home-row${stat ? ' is-stat' : ''}`} onClick={onOpen} aria-label={label}>
    <span className="home-row-num numeric">{value}{unit && <small>{unit}</small>}</span>
    <span className="home-row-text">{title}{note && <small>{note}</small>}{children}</span>
    <ChevronRightIcon className="home-chev" aria-hidden="true"/>
  </button>;
}
function Progress({value,muted}:{value:number;muted?:boolean}) {
  return <span className={`home-progress${muted ? ' is-muted' : ''}`} aria-hidden="true"><i style={{width:`${Math.round(Math.max(0,Math.min(1,value))*100)}%`}}/></span>;
}

const MEMO_ICONS:Record<MemoRow['kind'],Icon> = {checklist:ListBulletIcon,ledger:WalletIcon,secret:LockClosedIcon,text:DocumentTextIcon};
function MemoLine({row,onOpen}:{row:MemoRow;onOpen():void}) {
  const IconType = MEMO_ICONS[row.kind];
  const detail = row.kind === 'checklist' ? (row.total ? <><span className="numeric">{row.done}/{row.total}</span> 완료<Progress value={row.done/row.total} muted/></> : '빈 체크리스트')
    : row.kind === 'ledger' ? <>{row.month}월 {row.label} <span className="numeric">{grouped(row.amount)}</span>원</>
    : row.kind === 'secret' ? '암호 메모'
    : row.snippet || '내용 없음';
  return <button className="home-memo" onClick={onOpen}>
    <span className="home-memo-strip" style={row.color ? {background:row.color} : undefined} aria-hidden="true"/>
    <IconType className="home-card-icon" aria-hidden="true"/>
    <span className="home-memo-text"><strong>{row.title || '제목 없음'}</strong><small>{detail}</small></span>
    <ChevronRightIcon className="home-chev" aria-hidden="true"/>
  </button>;
}

type Kind = 'all'|'manga';

export function Home(props:HomeProps) {
  const {items,captures,paused,secondaryError} = props;
  const pending = captures ? captures.length : null;
  const d = useHomeDashboard({enabled:!paused,scope:props.scope,pending,reviewEnabled:props.review.enabled,reviewKey:props.review.refreshKey,similarityKey:props.similarityKey,exchange:props.exchange});
  const memos = useHomeMemos(!paused,d.probe);
  const shelf = useSyncExternalStore(subscribeReleases,currentShelf);
  const works = useMemo(() => new Map((shelf?.works ?? []).map(work => [work.id,work])),[shelf]);
  const [kind,setKind] = useState<Kind>('all');
  const stale = d.offline;
  const today = localToday();

  // ① 확인할 것
  const open:Record<TodoKey,() => void> = {pending:props.onPending,character:props.onReview,similar:props.onSimilarity,duplicates:props.onDuplicates};
  const due = d.applicable.filter(key => (d.todos[key] ?? 0) > 0);
  const unknown = d.applicable.some(key => d.todos[key] === null);
  const firstDue = due[0];
  const todo = <Card icon={CheckCircleIcon} title="확인할 것" className="is-full" at={d.todosAt} onOpen={firstDue ? open[firstDue] : props.onLibrary}
    calm={due.length ? undefined : unknown ? <span>{stale ? '마지막 값 없음' : '확인하는 중…'}</span> : <Ok>모두 확인함</Ok>}>
    {due.length > 0 && <div className="home-cols">{due.map(key => {
      const value = d.todos[key]!, more = key === 'pending' && value >= PENDING_LIMIT, {label,unit,note} = TODO_LABELS[key];
      return <Row key={key} value={`${value}${more ? '+' : ''}`} unit={unit} title={label} note={note} onOpen={open[key]} label={`${label} ${value}${more ? '+' : ''}${unit}`}/>;
    })}</div>}
  </Card>;

  // ② 신간
  const releases = d.releases ?? [];
  const cover = (id:string,name:string) => {
    const work = works.get(id);
    return work ? <Artwork item={work} id={collectionCover(work)} revision={shelf?.revision ?? ''} active={!paused} label={name}/> : <span className="collection-art collection-art-manga"><span className="collection-art-placeholder"><RectangleStackIcon/></span></span>;
  };
  const unread = d.unreadWorks ?? 0;
  const news = <Card icon={BookOpenIcon} title="신간" className="is-full" at={stale ? d.releasesAt : null} onOpen={props.onReleases}
    sum={unread > 0 && releases.length > 0 ? <Sum value={unread} unit="편 안 읽음"/> : undefined}
    calm={unread > 0 && releases.length > 0 ? undefined : d.unreadWorks === null ? <span>{stale ? '마지막 값 없음' : '확인하는 중…'}</span>
      : <Ok>새 신간 없음{d.watched ? <> · 만화 <span className="numeric">{d.watched}</span>편 지켜보는 중</> : null}</Ok>}>
    {unread > 0 && releases.length > 0 && <div className="home-cols">{releases.slice(0,stale ? 2 : 4).map(row => <button key={row.id} className="home-release" onClick={() => props.onWork(row.id)}>
      <span className="home-release-cover">{cover(row.id,row.name)}</span>
      <span className="home-release-text"><strong>{row.name}</strong><small className={`is-${row.caption?.kind ?? 'new'}`}>{row.caption ? <>{row.caption.text}{row.caption.date && <span className="numeric"> · {row.caption.date}</span>}</> : `신간 알림 ${row.unread}`}</small></span>
      <ChevronRightIcon className="home-chev" aria-hidden="true"/>
    </button>)}</div>}
  </Card>;

  // ③ 발매 예정: only 만화 has a source today; 게임 · 영화 wait for PC-published data.
  const allUpcoming = d.upcoming ?? [];
  const soon = allUpcoming.filter(row => {const days = daysAfter(row.date,today); return days >= 0 && days <= UPCOMING_DAYS;});
  const later = allUpcoming.find(row => daysAfter(row.date,today) > UPCOMING_DAYS);
  const upcomingCard = <Card icon={CalendarDaysIcon} title="발매 예정" at={stale ? d.upcomingAt : null} onOpen={props.onReleases}
    sum={soon.length ? <Sum value={soon.length} unit={`권 · ${UPCOMING_DAYS}일 안`} plain/> : undefined}
    calm={soon.length ? undefined : d.upcoming === null ? <span>{stale ? '마지막 값 없음' : '불러오는 중…'}</span>
      : d.watched === 0 ? <span>신간 알림을 켠 만화 없음</span>
      : <span>{UPCOMING_DAYS}일 안에 없음{later && <> · 다음 <b className="numeric">{dateBlock(later.date,today).day}</b></>}</span>}>
    {soon.length > 0 && <>
      <div className="home-seg" role="group" aria-label="발매 예정 종류">
        <button aria-pressed={kind === 'all'} onClick={() => setKind('all')}>전체 <span className="numeric">{soon.length}</span></button>
        <button aria-pressed={kind === 'manga'} onClick={() => setKind('manga')}>만화 <span className="numeric">{soon.length}</span></button>
        <button disabled>게임 <small>준비 중</small></button>
        <button disabled>영화 <small>준비 중</small></button>
      </div>
      {soon.slice(0,stale ? 2 : 3).map(row => {const block = dateBlock(row.date,today), days = daysAfter(row.date,today); return <button key={`${row.id}:${row.volumeNumber}`} className="home-upcoming" onClick={() => props.onWork(row.id)}>
        <span className="home-upcoming-date numeric">{block.day}<small>{block.weekday}</small></span>
        <span className="home-upcoming-name">{row.name}<small><span className="home-kind">만화</span>{row.volumeNumber}권</small></span>
        <span className="home-upcoming-left numeric">{days === 0 ? '오늘' : `${days}일 후`}</span>
        <ChevronRightIcon className="home-chev" aria-hidden="true"/>
      </button>;})}
    </>}
  </Card>;

  // ④ 전송
  const exchange = props.exchange;
  const arrived = exchange?.configured ? exchange.unseen : 0;
  const sending = d.sending;
  const transfer = <Card icon={ArrowsUpDownIcon} title="전송" onOpen={props.onExchange}
    calm={arrived || sending ? undefined : exchange && !exchange.configured ? <span>연결한 기기 없음</span> : <Ok>받은 파일 · 보낼 파일 없음</Ok>}>
    {(arrived > 0 || sending) && <>
      {arrived > 0 && <Row value={arrived} unit="개" title="받은 파일" note={`${d.peer?.name ? `${d.peer.name}에서 · ` : ''}아직 안 봄`} onOpen={props.onExchange} label={`받은 파일 ${arrived}개`}/>}
      {sending && (stale
        ? <Row value={1 + sending.more} unit="개" title="보내기 멈춤" note="연결되면 이어서 보냄" onOpen={props.onExchange} label={`보내기 멈춤 ${1 + sending.more}개`}/>
        : <Row value={sending.progress === null ? '…' : Math.round(sending.progress*100)} unit={sending.progress === null ? undefined : '%'} title="보내는 중" onOpen={props.onExchange}
          label={`보내는 중 ${sending.name}${sending.more ? ` 외 ${sending.more}개` : ''}${sending.peer ? ` → ${sending.peer}` : ''}`}
          note={`${sending.name}${sending.more ? ` 외 ${sending.more}` : ''}${sending.peer ? ` → ${sending.peer}` : ''}`}>
          {sending.progress !== null && <Progress value={sending.progress}/>}
        </Row>)}
    </>}
  </Card>;

  // ⑤ 자산 현황: the library summary; an older server falls back to counting the first page.
  const summary = d.summary;
  const fallback = addedToday(items,props.hasMore);
  const added = summary ? {count:summary.addedToday,more:false} : fallback;
  const tagging = characterTagging(props.characters);
  const addedText = `${added.count.toLocaleString('ko-KR')}${added.more ? '+' : ''}`;
  const tagRow = tagging && <Row stat value={Math.floor(tagging.done*100)} unit="%" title="캐릭터 자동 태그" note={`미지정 ${tagging.left.toLocaleString('ko-KR')}장 남음`} onOpen={props.onLibrary} label={`캐릭터 자동 태그 ${Math.floor(tagging.done*100)}%`}>
    <Progress value={tagging.done} muted/>
  </Row>;
  const assetsCalm = !added.count && !summary?.unclassified;
  const assets = <Card icon={ChartBarIcon} title="자산 현황" at={summary ? d.summaryAt : null} onOpen={props.onRecent}
    calm={assetsCalm ? <span>{props.busy && !items.length && !summary ? '불러오는 중…' : <>{summary && <>이번 주 <b className="numeric">{summary.addedThisWeek.toLocaleString('ko-KR')}</b>장 · </>}오늘 <b className="numeric">0</b></>}{tagging && <> · 자동 태그 <b className="numeric">{Math.floor(tagging.done*100)}</b>%</>}</span> : undefined}>
    {!assetsCalm && <>
      <Row stat value={addedText} unit="장" title="오늘 추가" note={summary ? '오늘 0시부터' : '최근 저장에서 셈'} onOpen={props.onRecent} label={`오늘 추가 ${addedText}장`}/>
      {summary && <>
        <Row stat value={summary.addedThisWeek.toLocaleString('ko-KR')} unit="장" title="이번 주 추가" note="월요일부터" onOpen={props.onRecent} label={`이번 주 추가 ${summary.addedThisWeek}장`}/>
        <Row stat value={summary.total.toLocaleString('ko-KR')} unit="장" title="전체" note="라이브러리의 모든 자산" onOpen={props.onRecent} label={`전체 ${summary.total}장`}/>
        {/* The tablet has no 미분류 view yet: Library is the closest place. */}
        <Row stat value={summary.unclassified.toLocaleString('ko-KR')} unit="장" title="분류 안 됨" note="분류가 하나도 없는 자산" onOpen={props.onLibrary} label={`분류 안 됨 ${summary.unclassified}장`}/>
      </>}
      {tagRow}
    </>}
  </Card>;

  // ⑥ 메모: on-device, so it never goes stale offline.
  const pinned = memos?.rows ?? [];
  const memo = <Card icon={PinIcon} title="메모" onOpen={() => props.onNotes()}
    sum={pinned.length ? <Sum value={pinned.length} unit="개 고정" plain/> : undefined}
    calm={pinned.length ? undefined : <span>{memos === null ? '불러오는 중…' : memos.locked ? '메모가 잠겨 있음' : '고정한 메모 없음'}</span>}>
    {pinned.length > 0 && pinned.slice(0,3).map(row => <MemoLine key={row.id} row={row} onOpen={() => props.onNotes(row.id)}/>)}
  </Card>;

  // ⑧ 서버 상태: one line unless something is wrong.
  const job = d.catalogJob;
  const catalogRunning = job?.state === 'queued' || job?.state === 'running';
  const catalogFailed = job?.state === 'failed';
  const peerLine = d.peer ? `${d.peer.name} · ${agoLabel(d.peer.lastSeenAt)}` : 'PC 기록 없음';
  const catalogLine = catalogRunning ? `갱신 중${job.pages ? ` · ${job.pages}쪽` : ''}` : catalogFailed ? (job.error || '갱신 실패') : job?.state === 'completed' ? '갱신 완료' : '—';
  const wrong = stale || catalogFailed;
  const server = <Card icon={stale ? SignalSlashIcon : ServerStackIcon} title="서버 상태" className={wrong ? 'is-alert' : ''} onOpen={props.onSettings}
    calm={wrong ? undefined : <><span className={`home-dot${catalogRunning ? ' is-busy' : ''}`} aria-hidden="true"/><span>{catalogRunning ? `카탈로그 ${catalogLine}` : `연결됨 · ${peerLine}`}</span></>}>
    {wrong && <div className="home-server">
      <span><em>서버</em><span className={`home-dot${stale ? ' is-off' : ''}`} aria-hidden="true"/>{stale ? <>연결 안 됨{d.since && <small> · 마지막 연결 <span className="numeric">{clockLabel(d.since)}</span></small>}</> : '연결됨'}</span>
      <span><em>PC</em><span className="home-dot is-idle" aria-hidden="true"/>{peerLine}</span>
      {!stale && <span><em>카탈로그</em><span className={`home-dot${catalogFailed ? ' is-off' : ' is-idle'}`} aria-hidden="true"/>{catalogLine}</span>}
    </div>}
  </Card>;

  // Fixed order; the lower cards pair up two by two (the last one alone spans the row).
  const lower = [upcomingCard,transfer,assets,memo,server];
  return <div className={`home-scroll${stale ? ' is-stale' : ''}`} aria-label="홈">
    {stale && <div className="home-offline" role="status"><SignalSlashIcon aria-hidden="true"/><div>
      <strong>오프라인 — 서버에 닿지 않습니다</strong>
      <p>{d.since ? <>숫자와 목록은 <span className="numeric">{clockLabel(d.since)}</span> 기준으로 남겨 둔 값입니다. 메모는 그대로 쓸 수 있습니다.</> : '연결되면 다시 불러옵니다. 메모는 그대로 쓸 수 있습니다.'}</p>
    </div><button className="home-retry" onClick={() => {d.retry(); props.onRefresh?.();}}>다시 연결</button></div>}
    {todo}
    {news}
    <div className="home-grid">{lower.map((card,index) => <div key={index} className="home-cell">{card}</div>)}</div>
    {secondaryError && <p className="hint" role="status">{secondaryError}</p>}
  </div>;
}
