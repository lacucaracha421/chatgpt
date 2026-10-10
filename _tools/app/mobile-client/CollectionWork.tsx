import {usePerformerNames} from "./PerformerName";
import {performerName} from "../src/collections/av/performerName";
import {useWorkSurfaceReady} from "../src/collections/work/useWorkSurfaceReady";
import {WorkZoomObject, WorkZoomProvider, WorkZoomStage} from '../src/collections/work/WorkZoom';
import {WorkBackdrop} from '../src/collections/work/WorkBackdrop';
import {useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent, type ReactNode} from 'react';
import {ArrowPathIcon, ChevronLeftIcon, ChevronRightIcon} from '@heroicons/react/24/outline';
import {CaseInside, CollectionCase} from '../src/collections/case/CollectionCase';
import {playCaseSound} from '../src/collections/case/caseSounds';
import type {StageBox} from '../src/collections/case/fitCaseStage';
import {FlatJacket, HeroBand, WorkStrip, heroArtwork, workMeta} from '../src/collections/work/WorkStage';
import {MangaBookcase, MangaStage, type MangaWorkData} from '../src/collections/work/MangaBookcase';
import {MangaBook} from '../src/collections/work/MangaBook';
import {backFacts, insideFacts} from '../src/collections/work/workFacts';
import {CaseScore} from '../src/collections/case/CaseInside';
import {PersonPortrait} from './AvCollections';
import type {Fact} from '../src/collections/case/CollectionCase';
import {selectedSpine} from '../src/collections/launchBoxSpines';
import {StableImage} from '../src/shared/ui/StableImage';
import type {CollectionVolume as SharedVolume} from '../src/library/types';
import {Button,Skeleton} from './ui';
import {useArtworkSet, type ArtworkRequest} from './collectionArtwork';
import {collectionCover, coverFocuses, type CollectionDetail, type CollectionSummary, type CollectionVolume} from './collectionModel';
import {workCaseData} from './CollectionShelf';
import {workRecordFacts} from './CollectionPersonal';
import './collectionShelf.css';

/** Artwork kinds that are the object itself; the strip lists the rest (screenshots, art). */
const OBJECT_KINDS = ['cover', 'spine', 'back', 'volume_cover'];
const SWIPE_PX = 64;

/** The booklet uses the visible record, including queued tablet edits. */
function caseRecord(rows: [string, string][], stars: ReactNode): Fact[] {
  return [...rows.filter(([label]) => label === '상태'), ['내 별점', stars], ...rows.filter(([label]) => label === '기기')];
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

/** Previous / next work through explicit stage edge buttons. */
function StageEdges({previous, next, onStep}: {previous: boolean; next: boolean; onStep(offset: -1 | 1): void}) {
  return <>
    <button className="asset-viewer__edge asset-viewer__edge--left" aria-label="이전 작품" disabled={!previous} onClick={() => onStep(-1)}><ChevronLeftIcon/></button>
    <button className="asset-viewer__edge asset-viewer__edge--right" aria-label="다음 작품" disabled={!next} onClick={() => onStep(1)}><ChevronRightIcon/></button>
  </>;
}

type MangaShown = {item: CollectionDetail; manga: MangaWorkData; book: string | null; hero: string | null; spines: Record<string, string>; info: ReactNode};
type Shown = {item: CollectionDetail; revision: string; urls: Record<string, string>; position: number; total: number};
type CaseWorkProps = {
  item: CollectionDetail; revision: string; active: boolean; privacy: boolean; position: number; total: number;
  /** Published works resolve portrait crops owned by a different work, as in AvCast. */
  portraitSources?: CollectionSummary[];
  /** My rating as shown, including queued edits. */
  score(item: CollectionDetail): number | null;
  /** Status and device as shown, including queued edits; published values by default. */
  record?(item: CollectionDetail): [string, string][];
  onStep(offset: -1 | 1): void; info(item: CollectionDetail): ReactNode;
};
/**
 * The work screen for games, films and AV, in portrait: the hero band across the top of the
 * stage, the shared case (drag turns it, a tap opens it to the printed booklet),
 * the strip of views and artworks, then the information as a section below the stage (`info`).
 * Switching works keeps the shown work, inert, until the next one's actual faces, hero, backdrop and strip are decoded.
 */
export function CaseWork(props: CaseWorkProps) {
  const {item, revision, active, privacy, position, total} = props;
  const strip = item.artworks.filter(art => !OBJECT_KINDS.includes(art.kind) && art.id !== heroArtwork(item));
  const faces = useArtworkSet(item, privacy ? {} : {
    front: {id: item.type === 'av' ? artworkOf(item, 'cover') ?? item.selectedWorkArtworkId : collectionCover(item), original: true, asset: true},
    spine: {id: selectedSpine(item.artworks)?.id, original: true},
    back: {id: artworkOf(item, 'back'), original: true},
    hero: heroRequest(item),
    ...Object.fromEntries(strip.map(art => [`thumb:${art.id}`, {id: art.id, original: false}])),
  }, revision, active);
  const incoming = useMemo<Shown | null>(() => faces.ready ? {item, revision, urls: faces.urls, position, total} : null, [faces.ready, faces.urls, item, revision, position, total]);
  const [slots, setSlots] = useState<[Shown | null, Shown | null]>([null, null]);
  const [painted, setPainted] = useState<0 | 1>(0);
  const shown = slots[painted];
  const requested = useRef(incoming); requested.current = incoming;
  const metadataOnly = shown?.item.id === item.id && incoming && shown.urls === incoming.urls;
  const visible = metadataOnly ? incoming : shown;
  const [reset, setReset] = useState(0);
  const [entered, setEntered] = useState(false);
  useEffect(() => {
    if (!incoming || shown === incoming) return;
    const next = !shown || metadataOnly ? painted : painted === 0 ? 1 : 0;
    if (slots[next] === incoming) return;
    setSlots(current => next === 0 ? [incoming, current[1]] : [current[0], incoming]);
  }, [incoming, shown, metadataOnly, painted, slots]);
  if (!visible) return <Skeleton className="tablet-work__skeleton" label="작품을 불러오는 중"/>;
  const waiting = !incoming || visible !== incoming;
  const label = visible.item.type === 'av' ? 'AV 작품 화면' : visible.item.type === 'movie' ? '영화 작품 화면' : '게임 작품 화면';
  return <WorkZoomProvider workId={visible.item.id} reset={reset}><article className="tablet-work" style={{position: 'relative'}} aria-label={label} aria-busy={waiting || !entered} inert={waiting || undefined}>
    {slots.map((slot, index) => slot && <div key={index} data-work-pending={index !== painted && slot === incoming ? '' : undefined} aria-hidden={index !== painted} inert={index !== painted || waiting || undefined}
      style={index === painted ? undefined : {position: 'absolute', inset: 0, visibility: 'hidden', pointerEvents: 'none'}}>
      <CaseWorkSurface {...props} shown={index === painted ? visible : slot} current={index === painted} reset={reset} onReset={() => setReset(value => value + 1)} onReady={() => {
        if (index === painted) setEntered(true);
        if (index !== painted && slot === requested.current) setPainted(index as 0 | 1);
      }}/>
    </div>)}
  </article></WorkZoomProvider>;
}

function CaseWorkSurface({shown, current, active, privacy, score, record = workRecordFacts, portraitSources, onStep, info, reset, onReset, onReady}: CaseWorkProps & {shown: Shown; /** The painted slot; only its case plays sounds. */current: boolean; reset: number; onReset(): void; onReady(): void}) {
  const [stage, stageBox] = useStageBox(true);
  const [mode, setMode] = useState('case'), [picked, setPicked] = useState('case');
  // Counts the user's moves that visibly open or close the case; each one plays its case sound (as on the PC).
  const [caseTurn, setCaseTurn] = useState(0);
  const flatReady = useRef(false);
  const shownId = shown?.item.id;
  useEffect(() => { setMode('case'); setPicked('case'); flatReady.current = false; }, [shownId]);
  const work = shown.item.type === 'av' && shown.item.av ? {...shown.item, releaseDate: shown.item.av.releaseDate ?? null} : shown.item;
  const strip = work.artworks.filter(art => !OBJECT_KINDS.includes(art.kind) && art.id !== heroArtwork(work));
  const art = useArtworkSet(work, {art: {id: strip.some(entry => entry.id === picked) ? picked : null, original: true}}, shown.revision, active && !privacy);
  const presentation = JSON.stringify([work.id, shown.urls, privacy]);
  const ready = useWorkSurfaceReady(presentation, !shown.urls.hero || privacy, work.type !== 'av' || privacy || !shown.urls.front, onReady,
    JSON.stringify([work.id, shown.urls.front, shown.urls.spine, shown.urls.back, work.ownedPlatform, work.platforms, privacy]));
  useEffect(() => { if (art.ready && art.urls.art && picked !== 'case' && picked !== 'open' && picked !== 'flat') setMode(picked); }, [art.ready, art.urls.art, picked]);
  function pick(next: string) {
    setPicked(next);
    if (!(next === 'case' || next === 'open' || privacy || (next === 'flat' && flatReady.current))) return;
    // Views that hide the case (flat sheet, artwork) close it silently.
    if (next === 'open' ? mode !== 'open' : next === 'case' && mode === 'open') setCaseTurn(turn => turn + 1);
    setMode(next);
  }
  const data = {...workCaseData(work, shown.urls, privacy), title: work.av?.titleJa?.trim() || work.name, discLabel: [work.av?.productCode, work.av?.maker, work.av?.label].filter(Boolean).join(' · ')};
  const isObject = mode === 'case' || mode === 'open';
  const hidden: CSSProperties = {visibility: 'hidden', pointerEvents: 'none'};
  const people = usePerformerNames(work.av?.people ?? [], active && current && !privacy);
  return <>
    <div className="tablet-work__frame" style={{"--work-strip-height": work.type === 'av' || strip.length ? '76px' : '0px'} as CSSProperties}>
      {!privacy && shown.urls.hero && <HeroBand src={shown.urls.hero} manga={false} onReady={() => ready('hero')}/>}
      <WorkZoomStage stageRef={stage} className="work-stage tablet-work__stage" enabled={isObject || mode === 'flat'} onEmptyClick={() => { if (mode !== 'case' || picked !== 'case') pick('case'); }}>
        {work.type === 'av' && !privacy && <WorkBackdrop key={data.front} src={data.front} onReady={() => ready('backdrop')}/>}
        <WorkZoomObject>
        <div className="work-case-slot" style={isObject ? undefined : {...hidden, position: 'absolute', inset: 0}} inert={!isObject || undefined} aria-hidden={!isObject}>
          <CollectionCase key={work.id} data={data} large stageBox={stageBox} open={mode === 'open'} sound={current ? {turn: caseTurn, work: work.id} : undefined} onOpenChange={open => pick(open ? 'open' : 'case')} frontReset={reset}
            backContent={{hero: shown.urls.hero, overview: work.overview,
              screenshots: work.artworks.filter(art => art.kind === 'screenshot').slice(0, 3).map(art => shown.urls[`thumb:${art.id}`] ?? (art.id === heroArtwork(work) ? shown.urls.hero : null)).filter((url): url is string => Boolean(url)),
              facts: backFacts(work, work.av ?? null),
              publisher: work.type === 'av' ? work.av?.maker : work.type === 'movie' ? work.productionCompany : work.publisher,
              platformName: work.type === 'game' ? record(work).find(([label]) => label === '기기')?.[1] || work.platforms?.split('·')[0]?.trim() : null}}
            inside={<CaseInside title={work.name} type={work.type} hero={shown.urls.hero} front={data.front} privacy={privacy} record={caseRecord(record(work), <CaseScore score={score(work)}/>)} facts={insideFacts(work, work.av ?? null)}
              people={people.map(person => ({...person, name: person.creditName || performerName(person).primary, nameJa: performerName(person).secondary, portrait: person.portraitCrop || person.portraitImage ? <PersonPortrait person={person} current={work} items={portraitSources ?? [work]} revision={shown.revision} size="large"/> : null}))}/>}
            onReady={() => ready('object')}/>
        </div>
        {work.type === 'av' && <div className="work-flat-slot" style={mode === 'flat' ? undefined : hidden} aria-hidden={mode !== 'flat'} inert={mode !== 'flat' || undefined}>
          <FlatJacket key={work.id} data={data} stageBox={stageBox} onReady={() => { flatReady.current = true; if (picked === 'flat') setMode('flat'); }}/>
        </div>}
        </WorkZoomObject>
        {!isObject && mode !== 'flat' && art.urls.art && <div className="work-art"><StableImage src={art.urls.art} alt={`${data.title} 아트워크`} draggable={false}/></div>}
        <StageEdges previous={shown.position > 1} next={shown.position < shown.total} onStep={onStep}/>
        <Button className="tablet-work__front" size="icon" variant="ghost" aria-label="정면으로" onClick={onReset}><ArrowPathIcon aria-hidden="true"/></Button>
      </WorkZoomStage>
      <WorkStrip av={work.type === 'av'} mode={picked} frontThumbnailUrl={data.front} artworks={strip} privacy={privacy} thumbnailUrl={id => shown.urls[`thumb:${id}`] ?? null} onReady={() => ready('strip')} onPick={pick}/>
    </div>
    <header className="tablet-work__identity">
      <h1>{data.title}</h1>
      <small className="numeric">{workMeta(work, data.platform, work.av ?? null)}</small>
    </header>
    <div className="tablet-work__info">{info(work)}</div>
  </>;
}

/** The published volume as the shared bookcase reads it; a future local date is a pre-registered volume. */
export function sharedVolume(volume: CollectionVolume, today: string): SharedVolume {
  const date = volume.localReleaseDate ?? null;
  return {...volume, coverArtworkId: volume.coverArtworkId ?? null, localReleaseDate: date, isbn13: volume.isbn13 ?? null, releaseStatus: volume.releaseStatus ?? (date && date.slice(0, 10) > today ? 'upcoming' : null)};
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
  const spines = useArtworkSet(item, privacy ? {} : Object.fromEntries(volumes.flatMap(volume => volume.coverArtworkId ? [[volume.coverArtworkId, {id: volume.coverArtworkId, original: false}]] : [])), revision, active);
  const hero = useArtworkSet(item, privacy ? {} : {hero: heroRequest(item)}, revision, active);
  const incoming = useMemo<MangaShown | null>(() => book.ready && spines.ready && hero.ready ? {
    item, book: book.urls.book ?? null, hero: hero.urls.hero ?? null, spines: spines.urls, info,
    manga: {volumes, activeVolumeId: requested?.id ?? null, editionIndex: volumes[0]?.editionIndex ?? 0, latestKoreanVolume: latestKorean, focuses: coverFocuses(item.volumes),
      ownedNumbers: owned === null ? null : volumes.filter(volume => volume.volumeNumber <= owned).map(volume => volume.volumeNumber),
      scope: '', revision, ownership: null, management: null},
  } : null, [book.ready, book.urls, spines.ready, spines.urls, hero.ready, hero.urls, item, info, volumes, requested?.id, latestKorean, owned, revision]);
  const [slots, setSlots] = useState<[MangaShown | null, MangaShown | null]>([null, null]);
  const [painted, setPainted] = useState<0 | 1>(0);
  const shown = slots[painted];
  const requestedSurface = useRef(incoming); requestedSurface.current = incoming;
  const metadataOnly = shown && incoming && shown.item.id === incoming.item.id && shown.manga.activeVolumeId === incoming.manga.activeVolumeId && shown.book === incoming.book && shown.hero === incoming.hero && shown.spines === incoming.spines && JSON.stringify(shown.manga.volumes.map(volume => [volume.id, volume.coverArtworkId])) === JSON.stringify(incoming.manga.volumes.map(volume => [volume.id, volume.coverArtworkId]));
  const visible = metadataOnly ? incoming : shown;
  useEffect(() => {
    if (!incoming || shown === incoming) return;
    const next = !shown || metadataOnly ? painted : painted === 0 ? 1 : 0;
    if (slots[next] === incoming) return;
    setSlots(current => next === 0 ? [incoming, current[1]] : [current[0], incoming]);
  }, [incoming, shown, metadataOnly, slots, painted]);
  const [reset, setReset] = useState(0);
  const [entered, setEntered] = useState(false);
  if (!visible) return <Skeleton className="tablet-work__skeleton" label="작품을 불러오는 중"/>;
  const waiting = !incoming || visible !== incoming;
  return <WorkZoomProvider workId={visible.item.id} reset={reset}><article className="tablet-work tablet-work--manga" style={{position: 'relative'}} aria-label="만화 작품 화면" aria-busy={waiting || !entered} inert={waiting || undefined}>
    {slots.map((slot, index) => slot && <div key={index} data-work-pending={index !== painted && slot === incoming ? '' : undefined} aria-hidden={index !== painted} inert={index !== painted || waiting || undefined}
      style={index === painted ? undefined : {position: 'absolute', inset: 0, visibility: 'hidden', pointerEvents: 'none'}}>
      <MangaWorkSurface shown={index === painted ? visible : slot} privacy={privacy} reset={reset} onReset={() => setReset(value => value + 1)} onPick={setWanted} onEnlarge={onEnlarge} onReady={() => {
        if (index === painted) setEntered(true);
        if (index !== painted && slot === requestedSurface.current) setPainted(index as 0 | 1);
      }}/>
    </div>)}
  </article></WorkZoomProvider>;
}

function MangaWorkSurface({shown, privacy, reset, onReset, onPick, onEnlarge, onReady}: {shown: MangaShown; privacy: boolean; reset: number; onReset(): void; onPick(id: string): void; onEnlarge(id: string): void; onReady(): void}) {
  const {item, manga} = shown;
  const volume = manga.volumes.find(volume => volume.id === manga.activeVolumeId);
  const index = manga.volumes.findIndex(volume => volume.id === manga.activeVolumeId);
  const swipe = useSwipe(offset => { const next = manga.volumes[(index < 0 ? 0 : index) + offset]; if (next) onPick(next.id); });
  const presentation = JSON.stringify([item.id, manga.activeVolumeId, shown.book, shown.hero, shown.spines, privacy]);
  const ready = useWorkSurfaceReady(presentation, !shown.hero || privacy, !shown.book || privacy, onReady);
  return <>
    <div className="tablet-work__frame">
      {!privacy && shown.hero && <HeroBand src={shown.hero} manga onReady={() => ready('hero')}/>}
      <div className="tablet-work__manga-stage" {...swipe}>
        {!privacy && <WorkBackdrop key={shown.book} src={shown.book} onReady={() => ready('backdrop')}/>}
        {manga.volumes.length
          ? <MangaStage manga={manga} privacy={privacy} title={item.name} author={item.author ?? null} frontReset={reset} coverUrl={id => id === volume?.coverArtworkId ? shown.book : null} onPick={onPick} onReady={() => ready('object')}/>
          : <WorkZoomStage className="work-stage manga-work-stage"><WorkZoomObject><MangaBook key={shown.book} src={shown.book} title={item.name} author={item.author ?? null} volumeNumber={null} volumeTitle={item.name} focus={null} privacy={privacy} frontReset={reset} onReady={() => ready('object')}/></WorkZoomObject></WorkZoomStage>}
        <Button className="tablet-work__front" size="icon" variant="ghost" aria-label="정면으로" onClick={onReset}><ArrowPathIcon aria-hidden="true"/></Button>
      </div>
      <MangaBookcase key={`${item.id}:${manga.activeVolumeId}`} touchTargets manga={manga} privacy={privacy} coverUrl={id => shown.spines[id] ?? null} onPick={onPick} onEnlarge={id => {
        // The cover viewer stays shut in privacy mode, and so does the book sound.
        if (!privacy) playCaseSound('book', 'open');
        onEnlarge(id);
      }} onReady={() => ready('strip')}/>
    </div>
    <div className="tablet-work__info">{shown.info}</div>
  </>;
}
