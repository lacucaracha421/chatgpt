import {useMemo, useState, useSyncExternalStore, type ComponentType, type CSSProperties, type ReactNode, type SVGProps} from 'react';
import {ArrowsUpDownIcon, CheckCircleIcon, ChevronRightIcon, DocumentTextIcon, ListBulletIcon, LockClosedIcon, RectangleStackIcon, SignalSlashIcon, WalletIcon} from '@heroicons/react/24/outline';
import {Artwork} from './Collections';
import {collectionCover} from './collectionModel';
import {localToday} from './collectionReleases';
import {Cover} from './CoverGroup';
import {currentShelf, subscribeReleases} from './releaseStore';
import {addedToday, agoLabel, characterTagging, clockLabel, dateBlock, daysAfter, PENDING_LIMIT, shelfEntries, TODO_LABELS, UPCOMING_DAYS, useHomeDashboard, useHomeMemos, useHomeRevisit, type MemoRow, type RevisitGroup, type ShelfEntry, type TodoKey} from './homeDashboard';
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
  /** A 다시 보기 group's full list: `date` (과거의 이날) or a creator key. */
  onRevisit?(key:string,title:string):void;
  /** Notes, optionally opening one note. */
  onNotes(id?:string):void;
  /** 다시 연결: re-read the page behind Home as well. */
  onRefresh?():void;
}

type Icon = ComponentType<SVGProps<SVGSVGElement>>;
const grouped = (amount:number) => `${amount < 0 ? '−' : ''}${String(Math.trunc(Math.abs(amount))).replace(/\B(?=(\d{3})+(?!\d))/g,',')}`;
const count = (value:number) => value.toLocaleString('ko-KR');

function Stale({at}:{at:number|null|undefined}) {
  return at ? <span className="home-stale numeric">{clockLabel(at)} 기준</span> : null;
}
function Progress({value,muted}:{value:number;muted?:boolean}) {
  return <span className={`home-progress${muted ? ' is-muted' : ''}`} aria-hidden="true"><i style={{width:`${Math.round(Math.max(0,Math.min(1,value))*100)}%`}}/></span>;
}

/** A section: the app's index label (square + fading hairline), then an optional 전체 ›. */
function Section({title,meta,onMore,moreLabel,className = '',children}:{title:string;meta?:ReactNode;onMore?():void;moreLabel?:string;className?:string;children:ReactNode}) {
  return <section className={`home-sec ${className}`} aria-label={title}>
    <div className="home-sh"><h2>{title}</h2>{meta && <span className="home-sh-meta">{meta}</span>}<span className="home-sh-rule" aria-hidden="true"/>
      {onMore && <button className="home-sh-more" onClick={onMore} aria-label={moreLabel ?? `${title} 전체`}>전체<ChevronRightIcon aria-hidden="true"/></button>}
    </div>
    {children}
  </section>;
}

/** One number tile: the figure first, its meaning under it. Tiles share one surface cut by 1px lines. */
function Tile({value,unit,title,note,act,bar,onOpen,label,style}:{value:ReactNode;unit?:string;title:string;note?:ReactNode;act?:boolean;bar?:number;onOpen():void;label:string;style?:CSSProperties}) {
  return <button className={`home-tile${act ? ' is-act' : ''}`} onClick={onOpen} aria-label={label} style={style}>
    <span className="home-tile-n numeric">{value}{unit && <small>{unit}</small>}</span>
    <span className="home-tile-text"><span className="home-tile-l">{title}</span>{note && <span className="home-tile-s">{note}</span>}{bar !== undefined && <Progress value={bar} muted/>}</span>
  </button>;
}

const MEMO_ICONS:Record<MemoRow['kind'],Icon> = {checklist:ListBulletIcon,ledger:WalletIcon,secret:LockClosedIcon,text:DocumentTextIcon};
function MemoCard({row,onOpen}:{row:MemoRow;onOpen():void}) {
  const IconType = MEMO_ICONS[row.kind];
  const detail = row.kind === 'checklist' ? (row.total ? <><span className="numeric">{row.done}/{row.total}</span> 완료<Progress value={row.done/row.total} muted/></> : '빈 체크리스트')
    : row.kind === 'ledger' ? <>{row.month}월 {row.label} <span className="numeric">{grouped(row.amount)}</span>원</>
    : row.kind === 'secret' ? '암호 메모'
    : row.snippet || '내용 없음';
  return <button className="home-memo" onClick={onOpen}>
    <span className="home-memo-strip" style={row.color ? {background:row.color} : undefined} aria-hidden="true"/>
    <IconType className="home-icon" aria-hidden="true"/>
    <span className="home-memo-text"><strong>{row.title || '제목 없음'}</strong><small>{detail}</small></span>
    <ChevronRightIcon className="home-chev" aria-hidden="true"/>
  </button>;
}

/** A shelf cover under its date rail: 새 권 (newly out) or the release date with its D-day. */
function ShelfCover({entry,cover,today,onOpen}:{entry:ShelfEntry;cover:ReactNode;today:string;onOpen():void}) {
  const fresh = entry.kind === 'new';
  const todayNew = fresh && (!entry.date || entry.date === today);
  const block = entry.date ? dateBlock(entry.date,today) : null;
  const rail = fresh
    ? <span className="home-rail is-new"><span className="home-rail-d">{todayNew ? '새 권 · 오늘' : <><span className="numeric">{block!.day}</span> 나옴</>}</span></span>
    : <span className="home-rail"><span className="home-rail-d numeric">{block!.day}</span><span className="home-rail-w">{block!.weekday.slice(0,1)}</span><span className="home-rail-dd numeric">{entry.days === 0 ? '오늘' : `D-${entry.days}`}</span></span>;
  const volumes = fresh ? entry.volumes : `${entry.volumeNumber}권`;
  const when = fresh ? (todayNew ? '새 권' : `${block!.day} 나옴`) : `${block!.day} 발매`;
  return <button className="home-shelf-item" onClick={onOpen} aria-label={`${entry.name} ${volumes} · ${when}`}>
    {rail}
    <span className="home-shelf-art">{cover}{todayNew && <span className="home-newmark">NEW</span>}</span>
    <span className="home-shelf-title">{entry.name}</span>
    <span className="home-shelf-sub"><span className="home-kind">만화</span><span className="numeric">{volumes}</span></span>
  </button>;
}

/** Justified rows: every image at its own ratio (the flex weight), the row as tall as fills the width. */
function RevisitCard({group,paused,onOpen}:{group:RevisitGroup;paused:boolean;onOpen():void}) {
  const items = group.items.slice(0,7);
  const rows = items.length >= 5 ? [items.slice(0,3),items.slice(3)] : [items];
  const ratio = (asset:Asset) => Number(asset.width) > 0 && Number(asset.height) > 0 ? Math.max(.4,Math.min(2.6,Number(asset.width)/Number(asset.height))) : 1;
  return <button className="home-revisit" onClick={onOpen} aria-label={`${group.title}, ${group.label}`}>
    <span className="home-revisit-pics">{rows.map((row,index) => <span key={index} className="home-jrow">{row.map(asset => <span key={asset.id} className="home-jcell" style={{flexGrow:ratio(asset),aspectRatio:String(ratio(asset))}}><Cover asset={asset} paused={paused}/></span>)}</span>)}</span>
    <span className="home-revisit-cap"><span className="home-revisit-text"><strong>{group.title}</strong><small>{group.label}</small></span><ChevronRightIcon className="home-chev" aria-hidden="true"/></span>
  </button>;
}

export function Home(props:HomeProps) {
  const {items,captures,paused,secondaryError} = props;
  const pending = captures ? captures.length : null;
  const d = useHomeDashboard({enabled:!paused,scope:props.scope,pending,reviewEnabled:props.review.enabled,reviewKey:props.review.refreshKey,similarityKey:props.similarityKey,exchange:props.exchange});
  const memos = useHomeMemos(!paused,d.probe);
  const [retries,setRetries] = useState(0);
  const revisit = useHomeRevisit(!paused,`${d.offline}:${retries}`);
  const shelf = useSyncExternalStore(subscribeReleases,currentShelf);
  const works = useMemo(() => new Map((shelf?.works ?? []).map(work => [work.id,work])),[shelf]);
  const stale = d.offline;
  const today = localToday();

  // 확인할 것: only the counts waiting on the user, as tiles; nothing waiting folds into the status line.
  const open:Record<TodoKey,() => void> = {pending:props.onPending,character:props.onReview,similar:props.onSimilarity,duplicates:props.onDuplicates};
  const due = d.applicable.filter(key => (d.todos[key] ?? 0) > 0);
  const unknown = d.applicable.some(key => d.todos[key] === null);
  const todoTiles = due.map(key => {
    const value = d.todos[key]!, more = key === 'pending' && value >= PENDING_LIMIT, {label,unit,note} = TODO_LABELS[key];
    const shown = `${count(value)}${more ? '+' : ''}`;
    return <Tile key={key} act value={shown} unit={unit} title={label} note={note} onOpen={open[key]} label={`${label} ${value}${more ? '+' : ''}${unit}`}/>;
  });

  // 자산 현황: the library summary; an older server falls back to counting the first page.
  const summary = d.summary;
  const fallback = addedToday(items,props.hasMore);
  const added = summary ? {count:summary.addedToday,more:false} : fallback;
  const tagging = characterTagging(props.characters);
  const addedText = `${count(added.count)}${added.more ? '+' : ''}`;
  const wide = due.length === 0;
  const stats:{key:string;tile:(style?:CSSProperties) => ReactNode}[] = [
    {key:'today',tile:style => <Tile key="today" style={style} value={addedText} unit="장" title="오늘 추가" note={summary || wide ? undefined : '최근 저장에서 셈'} onOpen={props.onRecent} label={`오늘 추가 ${addedText}장`}/>},
    ...(summary ? [
      {key:'week',tile:(style?:CSSProperties) => <Tile key="week" style={style} value={count(summary.addedThisWeek)} unit="장" title="이번 주" onOpen={props.onRecent} label={`이번 주 추가 ${summary.addedThisWeek}장`}/>},
      {key:'total',tile:(style?:CSSProperties) => <Tile key="total" style={style} value={count(summary.total)} unit="장" title="전체" onOpen={props.onRecent} label={`전체 ${summary.total}장`}/>},
      // The tablet has no 미분류 view yet: Library is the closest place.
      {key:'unclassified',tile:(style?:CSSProperties) => <Tile key="unclassified" style={style} value={count(summary.unclassified)} unit="장" title="분류 안 됨" onOpen={props.onLibrary} label={`분류 안 됨 ${summary.unclassified}장`}/>},
    ] : []),
    ...(tagging ? [{key:'tag',tile:(style?:CSSProperties) => <Tile key="tag" style={style} value={Math.floor(tagging.done*100)} unit="%" title="캐릭터 자동 태그" note={wide ? undefined : `미지정 ${count(tagging.left)}장`} bar={tagging.done} onOpen={props.onLibrary} label={`캐릭터 자동 태그 ${Math.floor(tagging.done*100)}%`}/>}] : []),
  ];
  // Beside 확인할 것: three columns, the last tile filling its row. Alone: one row, 자동 태그 a little wider.
  const columns = Math.min(3,stats.length);
  const statGrid = wide
    ? <div className="home-tiles home-stats is-row" style={{gridTemplateColumns:stats.map(stat => stat.key === 'tag' ? 'minmax(0,1.4fr)' : 'minmax(0,1fr)').join(' ')}}>{stats.map(stat => stat.tile())}</div>
    : <div className="home-tiles home-stats" style={{gridTemplateColumns:`repeat(${columns},minmax(0,1fr))`}}>{stats.map((stat,index) => stat.tile(index === stats.length - 1 ? {gridColumn:`span ${columns - (index % columns)}`} : undefined))}</div>;
  const assets = <Section title="자산 현황" meta={<Stale at={summary ? d.summaryAt : null}/>} onMore={props.onRecent} moreLabel="최근 저장 전체">{statGrid}</Section>;
  const top = wide ? assets : <div className="home-top">
    <Section title="확인할 것" meta={<Stale at={d.todosAt}/>} className="home-todo-sec"><div className={`home-tiles home-todo${due.length > 2 ? ' is-many' : ''}`}>{todoTiles}</div></Section>
    {assets}
  </div>;

  // 신간 · 발매 예정: one cover shelf, newly released volumes first, then the next 30 days by date.
  const unread = d.unreadWorks ?? 0;
  const releases = unread > 0 ? d.releases ?? [] : [];
  const entries = shelfEntries(releases,d.upcoming ?? [],today);
  const newCount = entries.filter(entry => entry.kind === 'new').length;
  const soonCount = entries.length - newCount;
  const later = (d.upcoming ?? []).find(row => daysAfter(row.date,today) > UPCOMING_DAYS);
  const cover = (id:string,name:string) => {
    const work = works.get(id);
    return work ? <Artwork item={work} id={collectionCover(work)} revision={shelf?.revision ?? ''} active={!paused} label={name}/> : <span className="collection-art collection-art-manga"><span className="collection-art-placeholder"><RectangleStackIcon/></span></span>;
  };
  const shelfTitle = newCount && soonCount ? '신간 · 발매 예정' : newCount ? '신간' : '발매 예정';
  const shelfSection = entries.length > 0 && <Section title={shelfTitle} onMore={props.onReleases} moreLabel="신간 · 발매 예정 전체"
    meta={<>{newCount > 0 && <>새 권 <span className="numeric">{newCount}</span></>}{newCount > 0 && soonCount > 0 && ' · '}{soonCount > 0 && <><span className="numeric">{UPCOMING_DAYS}</span>일 안 <span className="numeric">{soonCount}</span></>}<Stale at={stale ? d.releasesAt ?? d.upcomingAt : null}/></>}>
    <div className="home-shelf">{entries.slice(0,stale ? 8 : 16).map(entry => <ShelfCover key={`${entry.kind}:${entry.id}:${entry.kind === 'upcoming' ? entry.volumeNumber : ''}`} entry={entry} today={today} cover={cover(entry.id,entry.name)} onOpen={() => props.onWork(entry.id)}/>)}</div>
  </Section>;

  // The status line: everything quiet in one line, a running transfer with its progress, the server dot.
  const exchange = props.exchange;
  const arrived = exchange?.configured ? exchange.unseen : 0;
  const sending = d.sending;
  const quiet:string[] = [];
  if (!due.length) quiet.push(unknown ? (stale ? '확인할 것 마지막 값 없음' : '확인하는 중…') : '확인할 것 없음');
  if (!arrived && !sending && exchange) quiet.push(exchange.configured ? '받은 · 보낼 파일 없음' : '연결한 기기 없음');
  const releasesKnown = d.unreadWorks !== null;
  const newsQuiet = releasesKnown && newCount === 0;
  const job = d.catalogJob;
  const catalogRunning = job?.state === 'queued' || job?.state === 'running';
  const catalogFailed = job?.state === 'failed';
  const peerLine = d.peer ? `${d.peer.name} · ${agoLabel(d.peer.lastSeenAt)}` : 'PC 기록 없음';
  const serverText = stale ? '연결 안 됨' : catalogFailed ? (job.error || '카탈로그 갱신 실패') : catalogRunning ? `카탈로그 갱신 중${job.pages ? ` · ${job.pages}쪽` : ''}` : '서버';
  const status = <div className={`home-status${stale || catalogFailed ? ' is-alert' : ''}`} role="group" aria-label="상태">
    {sending && <button className="home-seg is-grow" onClick={props.onExchange}
      aria-label={stale ? `보내기 멈춤 ${1 + sending.more}개` : `보내는 중 ${sending.name}${sending.more ? ` 외 ${sending.more}개` : ''}${sending.peer ? ` → ${sending.peer}` : ''}`}>
      <ArrowsUpDownIcon className="home-icon" aria-hidden="true"/>
      {stale ? <><b>보내기 멈춤</b><span className="numeric">{1 + sending.more}</span>개<span className="home-seg-text">연결되면 이어서 보냄</span></>
        : <><b>보내는 중</b>{sending.progress !== null && <><span className="numeric">{Math.round(sending.progress*100)}%</span><Progress value={sending.progress}/></>}
          <span className="home-seg-text">{sending.name}{sending.more ? ` 외 ${sending.more}` : ''}{sending.peer ? ` → ${sending.peer}` : ''}</span></>}
    </button>}
    {arrived > 0 && <button className="home-seg" onClick={props.onExchange} aria-label={`받은 파일 ${arrived}개`}><b>받은 파일</b><span className="numeric is-accent">{arrived}</span></button>}
    {quiet.length > 0 && <span className="home-seg is-grow is-quiet">{!unknown || due.length ? <CheckCircleIcon className="home-ok" aria-hidden="true"/> : null}<span className="home-seg-text">{quiet.join(' · ')}</span></span>}
    {newsQuiet && <button className="home-seg is-news" onClick={props.onReleases} aria-label="신간 · 발매 예정">
      <span className="home-seg-text">새 신간 없음{d.watched ? <> · 만화 <span className="numeric">{d.watched}</span>편 지켜보는 중</> : null}{!soonCount && later ? <> · 다음 발매 <span className="numeric">{dateBlock(later.date,today).day}</span></> : null}</span>
    </button>}
    <button className="home-seg is-server" onClick={props.onSettings} aria-label={`서버 상태: ${stale ? `연결 안 됨${d.since ? ` · 마지막 연결 ${clockLabel(d.since)}` : ''}` : `연결됨 · ${peerLine}${job ? ` · 카탈로그 ${catalogRunning ? '갱신 중' : catalogFailed ? '갱신 실패' : '갱신 완료'}` : ''}`}`}>
      <span className={`home-dot${stale || catalogFailed ? ' is-off' : catalogRunning ? ' is-busy' : ''}`} aria-hidden="true"/><span className="home-seg-text">{serverText}</span>
      <ChevronRightIcon className="home-chev" aria-hidden="true"/>
    </button>
  </div>;

  // 다시 보기: 과거의 이날 and 다시 만난 작가, only when the server has them.
  const revisitSection = revisit.length > 0 && <Section title="다시 보기" meta="예전에 모은 것">
    <div className={`home-revisits${revisit.length === 1 ? ' is-single' : ''}`}>{revisit.slice(0,2).map(group => <RevisitCard key={group.key} group={group} paused={paused}
      onOpen={() => props.onRevisit?.(group.key,group.key === 'date' ? group.title : group.name ?? group.title)}/>)}</div>
  </Section>;

  // 메모: on-device, so it never goes stale offline.
  const pinned = memos?.rows ?? [];
  const memo = <Section title="메모" onMore={() => props.onNotes()} moreLabel="메모 전체"
    meta={pinned.length ? <>고정 <span className="numeric">{pinned.length}</span></> : memos === null ? '불러오는 중…' : memos.locked ? '메모가 잠겨 있음' : '고정한 메모 없음'}>
    {pinned.length > 0 && <div className="home-memos">{pinned.slice(0,4).map(row => <MemoCard key={row.id} row={row} onOpen={() => props.onNotes(row.id)}/>)}</div>}
  </Section>;

  return <div className={`home-scroll${stale ? ' is-stale' : ''}`} aria-label="홈">
    {stale && <div className="home-offline" role="status"><SignalSlashIcon aria-hidden="true"/><div>
      <strong>오프라인 — 서버에 닿지 않습니다</strong>
      <p>{d.since ? <>숫자와 목록은 <span className="numeric">{clockLabel(d.since)}</span> 기준으로 남겨 둔 값입니다. 메모는 그대로 쓸 수 있습니다.</> : '연결되면 다시 불러옵니다. 메모는 그대로 쓸 수 있습니다.'}</p>
    </div><button className="home-retry" onClick={() => {d.retry(); setRetries(n => n + 1); props.onRefresh?.();}}>다시 연결</button></div>}
    {top}
    {status}
    {shelfSection}
    {revisitSection}
    {memo}
    {secondaryError && <p className="hint" role="status">{secondaryError}</p>}
  </div>;
}
