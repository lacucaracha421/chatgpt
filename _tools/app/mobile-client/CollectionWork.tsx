import {WorkZoomObject, WorkZoomProvider, WorkZoomStage} from '../src/collections/work/WorkZoom';
import {WorkBackdrop} from '../src/collections/work/WorkBackdrop';
import {useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent, type ReactNode} from 'react';
import {ArrowPathIcon, ChevronLeftIcon, ChevronRightIcon} from '@heroicons/react/24/outline';
import {CaseInside, CollectionCase} from '../src/collections/case/CollectionCase';
import type {StageBox} from '../src/collections/case/fitCaseStage';
import {FlatJacket, HeroBand, WorkStrip, heroArtwork, workMeta} from '../src/collections/work/WorkStage';
import {MangaBookcase, MangaStage, type MangaWorkData} from '../src/collections/work/MangaBookcase';
import {MangaBook} from '../src/collections/work/MangaBook';
import {insideFacts} from '../src/collections/work/workFacts';
import {RecordStars} from '../src/collections/work/WorkRecord';
import type {Fact} from '../src/collections/case/CollectionCase';
import {selectedSpine} from '../src/collections/launchBoxSpines';
import {StableImage} from '../src/shared/ui/StableImage';
import type {CollectionVolume as SharedVolume} from '../src/library/types';
import {Button} from './ui';
import {useArtworkSet, type ArtworkRequest} from './collectionArtwork';
import {collectionCover, coverFocuses, type CollectionDetail, type CollectionVolume} from './collectionModel';
import {workCaseData} from './CollectionShelf';
import {workRecordFacts} from './CollectionPersonal';
import './collectionShelf.css';

/** Artwork kinds that are the object itself; the strip lists the rest (screenshots, art). */
const OBJECT_KINDS = ['cover', 'spine', 'back', 'volume_cover'];
const SWIPE_PX = 64;

/** The case's 내 기록 slip in the PC's order (상태, 별점, 기기); 상태 and 기기 only when recorded. */
function caseRecord(rows: [string, string][], stars: ReactNode): Fact[] {
  return [...rows.filter(([label]) => label === '상태'), ['별점', stars], ...rows.filter(([label]) => label === '기기')];
}

/** The kind's selected artwork, else its first. */
function artworkOf(item: CollectionDetail, kind: string) {
  const all = item.artworks.filter(art => art.kind === kind);
  return (all.find(art => art.selected) ?? all[0])?.id ?? null;
}
function heroRequest(item: CollectionDetail): ArtworkRequest {
  const id = heroArtwork(item);
  // A hero published without its original still has its thumbnail.
  return {id, original: item.artworks.find(art => art.id === id)?.originalAvailable !== false};
}

/** Measures the stage so the shared case and jacket fit it (as `fitCaseStage` does on the PC); `mounted` re-measures once the stage replaces the skeleton. */
function useStageBox(mounted: boolean) {
  const stage = useRef<HTMLDivElement>(null);
  const [box, setBox] = useState<StageBox>();
  useLayoutEffect(() => {
    const node = stage.current; if (!node) return;
    const measure = () => {
      const {width, height} = node.getBoundingClientRect();
      if (width > 0 && height > 0) setBox(previous => previous?.width === width && previous.height === height ? previous : {width, height});
    };
    measure();
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure);
    observer?.observe(node);
    return () => observer?.disconnect();
  }, [mounted]);
  return [stage, box] as const;
}

/**
 * A horizontal swipe on the stage, outside the object: the case and the book turn under the
 * finger instead (they own their drag), and vertical moves scroll the page (`touch-action: pan-y`).
 */
function useSwipe(onSwipe: (offset: -1 | 1) => void) {
  const start = useRef<{id: number; x: number; y: number} | null>(null);
  const swipe = useRef(onSwipe); swipe.current = onSwipe;
  return {
    onPointerDown: (event: ReactPointerEvent<HTMLElement>) => {
      const target = event.target as Element;
      start.current = target.closest('.kase,.manga-bigbook,button') ? null : {id: event.pointerId, x: event.clientX, y: event.clientY};
    },
    onPointerUp: (event: ReactPointerEvent<HTMLElement>) => {
      const from = start.current; start.current = null;
      if (!from || from.id !== event.pointerId) return;
      const dx = event.clientX - from.x, dy = event.clientY - from.y;
      if (Math.abs(dx) >= SWIPE_PX && Math.abs(dx) > Math.abs(dy) * 2) swipe.current(dx < 0 ? 1 : -1);
    },
    onPointerCancel: () => { start.current = null; },
  };
}

/** Previous / next on the stage edges, the same viewer edges as the manga stage's; a swipe does the same. */
function StageEdges({previous, next, onStep}: {previous: boolean; next: boolean; onStep(offset: -1 | 1): void}) {
  return <>
    <button className="asset-viewer__edge asset-viewer__edge--left" aria-label="이전 작품" disabled={!previous} onClick={() => onStep(-1)}><ChevronLeftIcon/></button>
    <button className="asset-viewer__edge asset-viewer__edge--right" aria-label="다음 작품" disabled={!next} onClick={() => onStep(1)}><ChevronRightIcon/></button>
  </>;
}

type Shown = {item: CollectionDetail; revision: string; urls: Record<string, string>};
/**
 * The work screen for games, films and AV, in portrait: the hero band across the top of the
 * stage, the shared case (drag turns it, a tap opens it to the 내 기록 slip and 작품 정보 card),
 * the strip of views and artworks, then the information as a section below the stage (`info`).
 * Switching works keeps the shown work, inert, until the next one's faces are decoded.
 */
export function CaseWork({item, revision, active, privacy, position, total, score, record = workRecordFacts, onStep, info}: {
  item: CollectionDetail; revision: string; active: boolean; privacy: boolean; position: number; total: number;
  /** My rating as shown (a queued edit included) for the slip inside the case. */score(item: CollectionDetail): number | null;
  /** 상태 and 기기 as shown (a queued edit included); the published values by default. */record?(item: CollectionDetail): [string, string][];
  onStep(offset: -1 | 1): void; info(item: CollectionDetail): ReactNode;
}) {
  const faces = useArtworkSet(item, privacy ? {} : {
    front: {id: item.type === 'av' ? artworkOf(item, 'cover') ?? item.selectedWorkArtworkId : collectionCover(item), original: true, asset: true},
    spine: {id: selectedSpine(item.artworks)?.id, original: true},
    back: {id: item.type === 'av' ? artworkOf(item, 'back') : null, original: true},
    hero: heroRequest(item),
  }, revision, active);
  const [shown, setShown] = useState<Shown | null>(null);
  useEffect(() => {
    if (faces.ready && (shown?.item !== item || shown.urls !== faces.urls)) setShown({item, revision, urls: faces.urls});
  }, [faces.ready, faces.urls, item, revision, shown]);
  const [stage, stageBox] = useStageBox(shown !== null);
  const swipe = useSwipe(offset => { if ((offset < 0 && position > 1) || (offset > 0 && position < total)) onStep(offset); });
  const [mode, setMode] = useState('case'), [picked, setPicked] = useState('case'), [reset, setReset] = useState(0);
  const flatReady = useRef(false);
  const shownId = shown?.item.id;
  useEffect(() => { setMode('case'); setPicked('case'); flatReady.current = false; }, [shownId]);
  const work = shown?.item ?? item;
  const strip = work.artworks.filter(art => !OBJECT_KINDS.includes(art.kind) && art.id !== heroArtwork(work));
  const thumbs = useArtworkSet(work, Object.fromEntries(strip.map(art => [art.id, {id: art.id, original: false}])), shown?.revision ?? revision, active && !privacy, false);
  const art = useArtworkSet(work, {art: {id: strip.some(entry => entry.id === picked) ? picked : null, original: true}}, shown?.revision ?? revision, active && !privacy);
  useEffect(() => { if (art.ready && art.urls.art && picked !== 'case' && picked !== 'open' && picked !== 'flat') setMode(picked); }, [art.ready, art.urls.art, picked]);
  function pick(next: string) {
    setPicked(next);
    if (next === 'case' || next === 'open' || privacy || (next === 'flat' && flatReady.current)) setMode(next);
  }
  if (!shown) return <div className="tablet-work__skeleton ui-skeleton" aria-label="작품을 불러오는 중" aria-busy="true"/>;
  const data = {...workCaseData(work, shown.urls, privacy), title: work.av?.titleJa?.trim() || work.name};
  const waiting = shown.item.id !== item.id;
  const isObject = mode === 'case' || mode === 'open';
  const hidden: CSSProperties = {visibility: 'hidden', pointerEvents: 'none'};
  const people = work.av?.people ?? [];
  const label = work.type === 'av' ? 'AV 작품 화면' : work.type === 'movie' ? '영화 작품 화면' : '게임 작품 화면';
  return <WorkZoomProvider workId={work.id} reset={reset}><article className="tablet-work" aria-label={label} aria-busy={waiting} inert={waiting || undefined}>
    <div className="tablet-work__frame">
      {shown.urls.hero && <HeroBand src={shown.urls.hero} manga={false} onReady={() => undefined}/>}
      <WorkZoomStage stageRef={stage} className="work-stage tablet-work__stage" enabled={isObject || mode === 'flat'} {...swipe}>
        {work.type === 'av' && !privacy && <WorkBackdrop src={data.front}/>}
        <WorkZoomObject>
        <div className="work-case-slot" style={isObject ? undefined : {...hidden, position: 'absolute', inset: 0}} inert={!isObject || undefined} aria-hidden={!isObject}>
          <CollectionCase key={work.id} data={data} large stageBox={stageBox} open={mode === 'open'} onOpenChange={open => pick(open ? 'open' : 'case')} frontReset={reset}
            inside={<CaseInside record={caseRecord(record(work), <RecordStars score={score(work)}/>)} facts={insideFacts(work, work.av ?? null)}/>}
            note={people.length ? <><b>출연 · 감독</b><p className="work-names-note">{people.map(person => person.name).join(' · ')}</p></> : undefined}/>
        </div>
        {work.type === 'av' && <div className="work-flat-slot" style={mode === 'flat' ? undefined : hidden} aria-hidden={mode !== 'flat'} inert={mode !== 'flat' || undefined}>
          <FlatJacket key={work.id} data={data} stageBox={stageBox} onReady={() => { flatReady.current = true; if (picked === 'flat') setMode('flat'); }}/>
        </div>}
        </WorkZoomObject>
        {!isObject && mode !== 'flat' && art.urls.art && <div className="work-art"><StableImage src={art.urls.art} alt={`${data.title} 아트워크`} draggable={false}/></div>}
        <StageEdges previous={position > 1} next={position < total} onStep={onStep}/>
        <Button className="tablet-work__front" size="icon" variant="ghost" aria-label="정면으로" onClick={() => setReset(value => value + 1)}><ArrowPathIcon aria-hidden="true"/></Button>
      </WorkZoomStage>
      <WorkStrip av={work.type === 'av'} mode={picked} artworks={strip} privacy={privacy} thumbnailUrl={id => thumbs.urls[id] ?? null} onPick={pick}/>
    </div>
    <header className="tablet-work__identity">
      <h1>{data.title}</h1>
      <small className="numeric">{[workMeta(work, data.platform, work.av ?? null), `${position.toLocaleString()} / ${total.toLocaleString()}`].filter(Boolean).join(' · ')}</small>
    </header>
    <div className="tablet-work__info">{info(work)}</div>
  </article></WorkZoomProvider>;
}

/** The published volume as the shared bookcase reads it; a future local date is a pre-registered volume. */
export function sharedVolume(volume: CollectionVolume, today: string): SharedVolume {
  const date = volume.localReleaseDate ?? null;
  return {...volume, coverArtworkId: volume.coverArtworkId ?? null, localReleaseDate: date, isbn13: null, releaseStatus: date && date.slice(0, 10) > today ? 'upcoming' : null};
}

/**
 * The manga work screen: the shared book of the picked volume (drag turns it) over the shared
 * bookcase of the edition's volumes; a swipe or the stage edges change the volume, a double tap
 * on a spine opens the cover viewer. The information follows below the stage.
 */
export function MangaWork({item, revision, active, privacy, volumes, owned, latestKorean, initialVolumeId = null, onEnlarge, info}: {
  item: CollectionDetail; revision: string; active: boolean; privacy: boolean;
  /** The volume a list shelf opened the work at. */initialVolumeId?: string | null;
  /** The edition's volumes in order. */volumes: SharedVolume[];
  /** The edition's owned count (a queued edit included), or null when none is recorded. */owned: number | null;
  latestKorean: number | null; onEnlarge(volumeId: string): void; info: ReactNode;
}) {
  const [wanted, setWanted] = useState<string | null>(initialVolumeId);
  const requested = volumes.find(volume => volume.id === wanted) ?? volumes[0] ?? null;
  // An edition without volumes still has the work's own cover; the book shows that.
  const book = useArtworkSet(item, privacy ? {} : {book: requested ? {id: requested.coverArtworkId, original: true} : {id: collectionCover(item), original: true, asset: true}}, revision, active);
  const [shownVolume, setShownVolume] = useState<{id: string | null; url: string | null}>({id: null, url: null});
  useEffect(() => { if (book.ready) setShownVolume({id: requested?.id ?? null, url: book.urls.book ?? null}); }, [book.ready, book.urls.book, requested?.id]);
  const spines = useArtworkSet(item, privacy ? {} : Object.fromEntries(volumes.flatMap(volume => volume.coverArtworkId ? [[volume.coverArtworkId, {id: volume.coverArtworkId, original: false}]] : [])), revision, active, false);
  const hero = useArtworkSet(item, privacy ? {} : {hero: heroRequest(item)}, revision, active);
  const index = volumes.findIndex(volume => volume.id === shownVolume.id);
  const shown = volumes[index] ?? null;
  const step = (offset: -1 | 1) => { const next = volumes[(index < 0 ? 0 : index) + offset]; if (next) setWanted(next.id); };
  const swipe = useSwipe(step);
  const manga: MangaWorkData = {
    volumes, activeVolumeId: shown?.id ?? null, editionIndex: volumes[0]?.editionIndex ?? 0, latestKoreanVolume: latestKorean, focuses: coverFocuses(item.volumes),
    ownedNumbers: owned === null ? null : volumes.filter(volume => volume.volumeNumber <= owned).map(volume => volume.volumeNumber),
    scope: '', revision, ownership: null, management: null,
  };
  const [reset, setReset] = useState(0);
  return <WorkZoomProvider workId={item.id} reset={reset}><article className="tablet-work tablet-work--manga" aria-label="만화 작품 화면">
    <div className="tablet-work__frame">
      {hero.urls.hero && <HeroBand src={hero.urls.hero} manga onReady={() => undefined}/>}
      <div className="tablet-work__manga-stage" {...swipe}>
        {!privacy && <WorkBackdrop src={shownVolume.url}/>}
        {volumes.length
          ? <MangaStage manga={manga} privacy={privacy} title={item.name} author={item.author ?? null} frontReset={reset} coverUrl={id => id === shown?.coverArtworkId ? shownVolume.url : null} onPick={setWanted} onReady={() => undefined}/>
          : <WorkZoomStage className="work-stage manga-work-stage"><WorkZoomObject><MangaBook src={shownVolume.url} title={item.name} author={item.author ?? null} volumeNumber={null} volumeTitle={item.name} focus={null} privacy={privacy} frontReset={reset} onReady={() => undefined}/></WorkZoomObject></WorkZoomStage>}
        <Button className="tablet-work__front" size="icon" variant="ghost" aria-label="정면으로" onClick={() => setReset(value => value + 1)}><ArrowPathIcon aria-hidden="true"/></Button>
      </div>
      <MangaBookcase touchTargets manga={manga} privacy={privacy} coverUrl={id => spines.urls[id] ?? null} onPick={setWanted} onEnlarge={() => { if (shown) onEnlarge(shown.id); }}/>
    </div>
    <div className="tablet-work__info">{info}</div>
  </article></WorkZoomProvider>;
}
