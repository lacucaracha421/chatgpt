import {useMemo, useSyncExternalStore} from 'react';
import {BookOpenIcon, CalendarDaysIcon, CheckCircleIcon, ChevronRightIcon, CloudArrowUpIcon, ComputerDesktopIcon, RectangleStackIcon, SignalSlashIcon} from '@heroicons/react/24/outline';
import {Cover} from './CoverGroup';
import {Artwork} from './Collections';
import {collectionCover} from './collectionModel';
import {currentShelf, subscribeReleases} from './releaseStore';
import {agoLabel, clockLabel, dateBlock, PENDING_LIMIT, TODO_LABELS, useHomeDashboard, type HomeDashboard, type TodoKey} from './homeDashboard';
import {syncSignalsLive} from './syncSignals';
import type {ExchangeSnapshot} from './exchange';
import type {Asset, Classification, View} from './types';
import './home.css';

export interface HomeProps {
  items:Asset[];
  /** Kept for the App's Library navigation; this Home shows no folder discovery. */
  classifications:Classification[]; recentFolders:string[];
  /** The pending captures, or null before the first read. */
  captures:Asset[]|null;
  busy:boolean; paused:boolean; secondaryError:string;
  /** The connection the offline snapshot belongs to. */
  scope:string;
  exchange:ExchangeSnapshot|null;
  /** Character review (only when the library supports it) and similarity review, with the keys that re-read their counts. */
  review:{enabled:boolean;refreshKey:unknown}; similarityKey:unknown;
  onSelect(view:View):void; onOpen(index:number):void; onPending():void;
  onReview():void; onSimilarity():void; onDuplicates():void; onExchange():void;
  onReleases():void; onWork(id:string):void; onSettings():void;
}

/** Feature image plus this many masonry tiles from the first page of recent saves. */
const FEED = 13;
const localDay = (date:Date) => `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
function savedAt(asset:Asset) {
  const value = asset.collected_at ?? asset.created_at;
  const date = value ? new Date(value) : null;
  return date && Number.isFinite(date.getTime()) ? date : null;
}
function captionTime(asset:Asset,now:Date) {
  const date = savedAt(asset);
  if (!date) return '';
  return localDay(date) === localDay(now) ? clockLabel(date.getTime()) : `${date.getMonth()+1}.${date.getDate()}`;
}
/** The original aspect ratio (width / height), bounded so one extreme image cannot dominate a column. */
function ratioOf(asset:Asset) {
  const ratio = asset.width && asset.height ? asset.width/asset.height : asset.ratio;
  return ratio && Number.isFinite(ratio) && ratio > 0 ? Math.min(2,Math.max(.5,ratio)) : null;
}
/** Two columns, each tile going to the shorter one, in order. */
function masonry(items:{asset:Asset;index:number}[]) {
  const columns:{asset:Asset;index:number}[][] = [[],[]], heights = [0,0];
  for (const item of items) {
    const column = heights[0] <= heights[1] ? 0 : 1;
    columns[column].push(item); heights[column] += 1/(ratioOf(item.asset) ?? 1);
  }
  return columns;
}
const creatorOf = (asset:Asset) => asset.creator_name || asset.creator_handle || '';

function FeedTile({asset,index,now,paused,feature,onOpen}:{asset:Asset;index:number;now:Date;paused:boolean;feature?:boolean;onOpen(index:number):void}) {
  const ratio = ratioOf(asset), creator = creatorOf(asset), time = captionTime(asset,now);
  return <button className={`home-feed-tile${feature ? ' is-feature' : ''}${ratio ? '' : ' is-unsized'}`} data-asset-id={asset.id} onClick={() => onOpen(index)}
    aria-label={`${creator || (asset.kind === 'video' ? '영상' : '이미지')}${time ? `, ${time}` : ''}`}>
    <span className="home-feed-media" style={feature ? undefined : {aspectRatio:String(ratio ?? 1)}}><Cover asset={asset} paused={paused}/></span>
    <span className="home-feed-caption"><span>{creator}</span>{time && <time>{time}</time>}</span>
  </button>;
}

function Tile({label,value,unit,stale,more,onOpen}:{label:string;value:number|null;unit:string;stale:boolean;more?:boolean;onOpen():void}) {
  const shown = value === null ? '–' : `${value}${more ? '+' : ''}`;
  return <button className={`home-tile${stale ? ' is-stale' : ''}`} onClick={onOpen} aria-label={`${label} ${shown}${value === null ? '' : unit}`}>
    <span className="home-tile-label">{label}<ChevronRightIcon aria-hidden="true"/></span>
    <span className="home-tile-num numeric">{shown}{value !== null && <small>{unit}</small>}</span>
  </button>;
}

function StaleChip({at}:{at:number|null}) {
  return at ? <span className="home-stale numeric">{clockLabel(at)} 기준</span> : null;
}

function CardHead({icon:Icon,title,count,at,more,onMore}:{icon:typeof BookOpenIcon;title:string;count?:number|null;at?:number|null;more:string;onMore():void}) {
  return <div className="home-card-head">
    <Icon aria-hidden="true"/><h3>{title}</h3>{count != null && <span className="home-card-count numeric">{count}</span>}{at !== undefined && <StaleChip at={at}/>}
    <button className="home-card-more" onClick={onMore}>{more}<ChevronRightIcon aria-hidden="true"/></button>
  </div>;
}

export function Home(props:HomeProps) {
  const {items,captures,busy,paused,secondaryError,onSelect,onOpen,onPending} = props;
  const pending = captures ? captures.length : null;
  const d:HomeDashboard = useHomeDashboard({enabled:!paused,scope:props.scope,pending,reviewEnabled:props.review.enabled,reviewKey:props.review.refreshKey,similarityKey:props.similarityKey,exchange:props.exchange});
  const shelf = useSyncExternalStore(subscribeReleases,currentShelf);
  const works = useMemo(() => new Map((shelf?.works ?? []).map(work => [work.id,work])),[shelf]);
  const now = new Date();
  const stale = d.offline;
  const open:Record<TodoKey,() => void> = {pending:onPending,character:props.onReview,similar:props.onSimilarity,duplicates:props.onDuplicates,arrived:props.onExchange};
  const due = d.applicable.filter(key => (d.todos[key] ?? 0) > 0);
  const unknown = d.applicable.some(key => d.todos[key] === null);
  const calm = !due.length;
  const next = d.upcoming?.[0];
  const today = items.slice(0,40).filter(asset => {const date = savedAt(asset); return date && localDay(date) === localDay(now);}).length;
  const feed = items.slice(0,FEED);
  const columns = masonry(feed.slice(1).map((asset,offset) => ({asset,index:offset+1})));
  const releases = d.releases ?? [];
  const upcoming = d.upcoming ?? [];
  const cover = (id:string,name:string) => {
    const work = works.get(id);
    return work ? <Artwork item={work} id={collectionCover(work)} revision={shelf?.revision ?? ''} active={!paused} label={name}/> : <span className="collection-art collection-art-manga"><span className="collection-art-placeholder"><RectangleStackIcon/></span></span>;
  };
  const live = syncSignalsLive();

  return <div className="home-scroll" aria-label="홈">
    {stale && <div className="home-offline" role="status"><SignalSlashIcon aria-hidden="true"/><div>
      <strong>오프라인{d.since ? <> · <span className="numeric">{clockLabel(d.since)}</span> 기준</> : null}</strong>
      <p>{d.since ? '저장된 이미지는 볼 수 있어요. 숫자는 마지막으로 받은 값이에요.' : '저장된 이미지는 볼 수 있어요. 연결되면 다시 불러와요.'}</p>
    </div></div>}

    <section className={`home-summary${stale ? ' is-stale' : ''}`} aria-label="할 일">
      {calm ? <div className="home-tiles is-calm" style={{gridTemplateColumns:next ? '3fr 1fr 2fr' : '3fr 1fr'}}>
        <div className="home-tile is-calm-todo">
          <span className="home-tile-label">할 일</span>
          <span className="home-calm-line">{unknown ? <span>{stale ? '마지막 값 없음' : '확인하는 중…'}</span> : <><CheckCircleIcon aria-hidden="true"/><span>확인할 것 없음</span></>}</span>
          {!unknown && <span className="home-tile-note">{d.applicable.map(key => TODO_LABELS[key].label).join(' · ')} 모두 0</span>}
        </div>
        <Tile label="신간" value={d.unreadWorks} unit="편" stale={stale} onOpen={props.onReleases}/>
        {next && <button className="home-tile is-next" onClick={() => props.onWork(next.id)} aria-label={`다음 발매 ${dateBlock(next.date).day}, ${next.name} ${next.volumeNumber}권`}>
          <span className="home-tile-label">다음 발매<ChevronRightIcon aria-hidden="true"/></span>
          <span className="home-tile-num numeric">{dateBlock(next.date).day}<small>{next.name} {next.volumeNumber}권</small></span>
        </button>}
      </div> : <div className="home-tiles" style={{gridTemplateColumns:`repeat(${Math.max(due.length+1,3)},minmax(0,1fr))`}}>
        {due.map(key => <Tile key={key} label={TODO_LABELS[key].label} value={d.todos[key]} unit={TODO_LABELS[key].unit} stale={stale} more={key === 'pending' && d.todos[key] === PENDING_LIMIT} onOpen={open[key]}/>)}
        <Tile label="신간" value={d.unreadWorks} unit="편" stale={stale} onOpen={props.onReleases}/>
      </div>}
      {d.sending && <button className={`home-send${stale ? ' is-stale' : ''}`} onClick={props.onExchange}>
        <CloudArrowUpIcon aria-hidden="true"/>
        <span className="home-send-name">{stale ? '보내기 멈춤' : '보내는 중'} <span>{d.sending.name}{d.sending.more ? ` 외 ${d.sending.more}개` : ''}{d.sending.peer ? ` → ${d.sending.peer}` : ''}</span></span>
        {d.sending.progress !== null && <><span className="home-send-bar" aria-hidden="true"><span style={{width:`${Math.round(d.sending.progress*100)}%`}}/></span><span className="home-send-pct numeric">{Math.round(d.sending.progress*100)}%</span></>}
      </button>}
    </section>

    <div className="home-body">
      <section className="home-feed" aria-label="최근 저장">
        <div className="home-feed-head">
          <h3>최근 저장</h3>{today > 0 && <span className="home-card-count numeric">{today}<small>오늘</small></span>}
          <button className="home-card-more" onClick={() => onSelect({tab:'library',title:'최근 저장'})}>전체 보기<ChevronRightIcon aria-hidden="true"/></button>
        </div>
        {feed.length ? <>
          <FeedTile asset={feed[0]} index={0} now={now} paused={paused} feature onOpen={onOpen}/>
          <div className="home-masonry">{columns.map((column,index) => <div key={index}>{column.map(item => <FeedTile key={item.asset.id} asset={item.asset} index={item.index} now={now} paused={paused} onOpen={onOpen}/>)}</div>)}</div>
        </> : <p className="home-empty">{busy ? '최근 저장을 불러오는 중…' : '아직 동기화된 자산이 없습니다.'}</p>}
      </section>

      <div className="home-side">
        {releases.length > 0 && <section className="home-card" aria-label="신간">
          <CardHead icon={BookOpenIcon} title="신간" count={d.unreadWorks} at={stale ? d.releasesAt : undefined} more="모두" onMore={props.onReleases}/>
          {releases.slice(0,stale ? 4 : 5).map(row => <button key={row.id} className="home-release" onClick={() => props.onWork(row.id)}>
            <span className="home-release-cover">{cover(row.id,row.name)}</span>
            <span className="home-release-text"><strong>{row.name}</strong><small className={`is-${row.caption?.kind ?? 'new'}`}>{row.caption ? <>{row.caption.text}{row.caption.date && <span className="numeric"> · {row.caption.date}</span>}</> : `신간 알림 ${row.unread}`}</small></span>
            <ChevronRightIcon aria-hidden="true"/>
          </button>)}
        </section>}

        <section className="home-card" aria-label="발매 예정">
          <CardHead icon={CalendarDaysIcon} title="발매 예정" at={stale ? d.upcomingAt : undefined} more="신간 화면" onMore={props.onReleases}/>
          {upcoming.length ? upcoming.slice(0,calm ? 5 : 4).map(row => {const block = dateBlock(row.date); return <button key={`${row.id}:${row.volumeNumber}`} className="home-upcoming" onClick={() => props.onWork(row.id)}>
            <span className="home-upcoming-date numeric">{block.day}<small>{block.weekday}</small></span>
            <span className="home-upcoming-name">{row.name}</span>
            <span className="home-upcoming-volume">{row.volumeNumber}권 예약</span>
          </button>;}) : <p className="home-card-empty">{d.upcoming === null ? (stale ? '저장된 발매 정보가 없어요.' : '발매 정보를 불러오는 중…') : d.watched === 0 ? '신간 알림을 켠 만화가 없어요.' : '날짜가 정해진 예정 발매가 없어요.'}</p>}
        </section>

        <button className="home-card home-connection" onClick={props.onSettings} aria-label="연결 및 설정">
          <span className="home-connection-line"><span className={`home-dot${stale ? ' is-off' : ''}`} aria-hidden="true"/><strong>{stale ? '오프라인' : live ? '실시간 연결' : '주기 확인'}</strong></span>
          {d.peer && <span className="home-connection-line"><ComputerDesktopIcon aria-hidden="true"/>{d.peer.name} · <span className="numeric">{agoLabel(d.peer.lastSeenAt)}</span></span>}
        </button>
      </div>
    </div>
    {secondaryError && <p className="hint" role="status">{secondaryError}</p>}
  </div>;
}
