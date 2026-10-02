import {useCallback, useEffect, useLayoutEffect, useRef, useState, type SyntheticEvent} from 'react';
import {ArrowLeftIcon, ChevronLeftIcon, ChevronRightIcon, HeartIcon, InformationCircleIcon, ArrowPathIcon, MagnifyingGlassMinusIcon, FolderIcon, Square2StackIcon, TrashIcon, UserMinusIcon} from '@heroicons/react/24/outline';
import type {ComponentType, SVGProps} from 'react';
import {Dialog, DialogDescription, IconButton, Button} from './ui';
import {BottomSheet} from './BottomSheet';
import type {Asset} from './types';
import {imageNeighbours, fitTransform} from './model';
import {decodeImage, invalidateTicket, mediaTicket} from './media';
import {errorText} from './transport';
import {videoEvent, viewerTiming} from './perf';
import {AlbumMembershipEditor} from './AlbumMembershipEditor';
import {ClassificationAssignmentEditor} from './ClassificationAssignmentEditor';
import {CharacterExclusionEditor, type ExclusionRequest, type ExclusionKey, type ExclusionReceipt} from './CharacterExclusion';
import {ViewerInfo} from './ViewerInfo';
import {usePrivacyMode} from './privacyMode';
import {ViewerFilmstrip} from './ViewerFilmstrip';
import {useLikesAlbum} from './useLikesAlbum';
import {VideoPlayerSurface} from '../src/video/VideoPlayer';

import './Viewer.css';

/**
 * The character this viewer was opened from, when it was opened from a character node.
 *
 * The host supplies it only for that one origin. A series, group or ordinary folder gallery
 * passes nothing, because a manual exclusion names one character and none of those is one;
 * inventing a target there would exclude the asset from a character the user never chose.
 * The exclusion is composed from this value alone, so it can never outlive the origin that
 * carried it: an `assetId` belongs to whichever request was formed for the asset on screen.
 */
/**
 * Private Vault source. `original` is the native vault session route, used as-is: no tickets,
 * prepared/decoded caches, neighbour prefetch, timing logs, info panel or asset actions.
 */
export type ViewerVaultSource = {original(asset: Asset): string; label(asset: Asset): string};

export type ViewerCharacterContext = {targetId:string;name:string;libraryId:string;revision:string;protectedAssetIds:string[]};

function handleLabel(handle: string): string {
  const trimmed = handle.trim();
  return trimmed.startsWith('@') ? trimmed : `@${trimmed}`;
}

function viewerDateLabel(value?: string): string {
  if (!value) return '';
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return '';
  const month = date.getMonth() + 1;
  const day = date.getDate();
  const hour = String(date.getHours()).padStart(2, '0');
  const minute = String(date.getMinutes()).padStart(2, '0');
  return `${month}.${day} ${hour}:${minute}`;
}

/**
 * A viewer bar action that names itself with an icon and keeps the existing accessible name.
 * `name` is used where the established name is longer than the short action label.
 */
function ViewerAction({label, name, icon: Icon, active, danger, onClick}: {label: string; name?: string; icon: ComponentType<SVGProps<SVGSVGElement>>; active?: boolean; danger?: boolean; onClick(): void}) {
  return <Button type="button" size="icon" variant={danger ? 'danger' : 'ghost'} className={`viewer-action${danger ? ' is-danger' : ''}`} aria-label={name ?? label} aria-pressed={active} onClick={onClick}><Icon aria-hidden="true"/></Button>;
}
export function Viewer(props: Parameters<typeof ViewerContent>[0]) {
  const [privacy] = usePrivacyMode();
  const hidden = !props.vault && (privacy || !!props.privacy);
  useEffect(() => { if (hidden) props.onClose(); }, [hidden, props.onClose]);
  return hidden ? <span className="privacy-mask" aria-label="비공개 모드"/> : <ViewerContent {...props}/>;
}

function ViewerContent({items, index, onIndex, onClose,onNearEnd,backRef,endpoint,character,onCharacterExcluded,onTrash,trashNotice,totalCount,folderLabel,privacy,vault}: {items: Asset[]; index: number; onIndex(index: number): void; onClose(): void;onNearEnd?():void;backRef?: React.MutableRefObject<(() => boolean) | null>;endpoint?:string;character?:ViewerCharacterContext|null;onCharacterExcluded?(receipt:ExclusionReceipt):void;
  /** Move the Asset on screen to the Library Trash (no confirmation: it is reversible). */
  onTrash?(asset:Asset):void;
  /** The host's "휴지통으로 이동함 · 실행 취소" snackbar, rendered inside the modal viewer. */
  trashNotice?:React.ReactNode;
  /** The server total when the current page is only a slice of the gallery. */
  totalCount?: number | null;
  /** Optional current folder path for the second line of the viewer title. */
  folderLabel?: (asset: Asset) => string | null;
  /** Privacy mode keeps the media and filmstrip as plain, non-identifying blocks. */
  privacy?: boolean;
  /** Private Vault mode: same gestures, chrome and video controls; no library media or actions. */
  vault?:ViewerVaultSource}) {
  const asset = items[index];
  // The heart lives here, not on gallery tiles (user, 2026-10-02): one membership read per shown asset.
  const likes = useLikesAlbum(asset ? [asset.id] : [], !vault && !!asset && !asset.pending, asset?.id);
  useEffect(()=>{if(index>=items.length-3)onNearEnd?.();},[index,items.length,onNearEnd]);
  const timing=useRef<{id:string;url?:string;span:ReturnType<typeof viewerTiming>}|undefined>(undefined);
  const prepared=useRef(new Map<string,string>());
  const prefetches=useRef(new Map<string,{controller:AbortController; ticket:ReturnType<typeof mediaTicket>; decoded:Promise<void>}>());
  useEffect(()=>()=>{for(const work of prefetches.current.values())work.controller.abort();prefetches.current.clear();},[]);
  const [decoded, setDecoded] = useState<{id: string; url: string}>();
  const original = vault ? vault.original(asset) : decoded?.id === asset.id ? decoded.url : prepared.current.get(asset.id);
  // Vault images decode in place; the thumbnail covers the surface until the original has loaded.
  const [loaded, setLoaded] = useState('');
  const [error, setError] = useState('');
  const [retry, setRetry] = useState(0);
  const [info, setInfo] = useState(false);
  // Android Back has no listener inside the shared Dialog (`App` owns the only
  // `lakomics-back` handler), so the information panel follows the same `backRef`
  // idiom the Album browser uses: consume Back while it is open, so the viewer's own
  // Back handling runs only once the panel is closed.
  const infoOpen = useRef(false);
  infoOpen.current = info;
  /**
   * The confirmation's request identity, pinned to the Asset it was composed for.
   *
   * A swipe drops the open confirmation, but the pending operation itself stays durable
   * under its endpoint/library/target/asset key, so reopening the same pair resends the exact
   * body instead of composing a new one.
   */
  const [exclusion,setExclusion]=useState<ExclusionRequest|null>(null);
  const exclusionOpen = useRef(false);
  exclusionOpen.current = exclusion !== null;
  useEffect(() => {
    if (!backRef) return;
    backRef.current = () => {
      // The confirmation is the innermost overlay, so it consumes Back first: dismissing it
      // leaves the viewer open with its media untouched, which is what "취소" means here.
      if (exclusionOpen.current) { setExclusion(null); return true; }
      if (pickersOpen.current.classificationOpen) { setClassificationOpen(false); return true; }
      if (pickersOpen.current.albumOpen) { setAlbumOpen(false); return true; }
      if (infoOpen.current) { setInfo(false); return true; }
      return false;
    };
    return () => { backRef.current = null; };
  }, [backRef]);
  const [albumOpen, setAlbumOpen] = useState(false);
  const [classificationOpen, setClassificationOpen] = useState(false);
  const pickersOpen = useRef({albumOpen, classificationOpen});
  pickersOpen.current = {albumOpen, classificationOpen};
  const [chrome, setChrome] = useState(true);
  const [chromeActivity, setChromeActivity] = useState(0);
  const [filmstripActive, setFilmstripActive] = useState(false);
  const [landscape, setLandscape] = useState(() => window.innerWidth > window.innerHeight);
  const [transform, setTransform] = useState({scale: 1, x: 0, y: 0});
  const surface = useRef<HTMLDivElement>(null);
  const video = useRef<HTMLVideoElement>(null);
  const videoResume = useRef({id:'',time:0,playing:false});
  const stallTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  // Library video: no metadata within PROGRESS_MS of loadstart (or an element error) renews the
  // stream once, silently, before the delay/error message is shown.
  const progressTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const autoRetry = useRef({id:'',used:false});
  const gesture = useRef({points: new Map<number, {x: number; y: number}>(), startX: 0, startY: 0, distance: 0, scale: 1, lastX: 0, lastY: 0, moved: false, pinched: false});
  const revealChrome = useCallback(() => { setChrome(true); setChromeActivity(value => value + 1); }, []);
  const total = totalCount != null && Number.isFinite(totalCount) && totalCount >= items.length ? totalCount : items.length;
  const artistLabel = asset.creator_handle?.trim() ? handleLabel(asset.creator_handle) : asset.creator_name?.trim() || '저장한 이미지';
  const folder = folderLabel?.(asset)?.trim() || '';
  const metaLabel = [viewerDateLabel(asset.collected_at ?? asset.created_at), folder].filter(Boolean).join(' · ');
  useEffect(() => {
    const update = () => setLandscape(window.innerWidth > window.innerHeight);
    window.addEventListener('resize', update);
    window.addEventListener('orientationchange', update);
    return () => { window.removeEventListener('resize', update); window.removeEventListener('orientationchange', update); };
  }, []);
  useEffect(() => {
    if (vault) {
      // Moving to another item never brings the bars back; only direct viewer activity does.
      timing.current = undefined; setLoaded(''); setError(''); if (asset.kind === 'video') setChrome(true); gesture.current.points.clear();
      return () => clearTimeout(stallTimer.current);
    }
    const controller = new AbortController();
    const fromPrepared=prepared.current.has(asset.id)&&asset.kind!=='video'&&!retry;
    const span=viewerTiming(asset.id,asset.kind,fromPrepared);
    const observation={id:asset.id,url:fromPrepared?prepared.current.get(asset.id):undefined,span};
    timing.current=observation;
    span.log('open');
    // The info sheet/panel stays open across assets and swaps its content in place (PC viewer C).
    setDecoded(current => prepared.current.has(asset.id) ? {id:asset.id,url:prepared.current.get(asset.id)!} : current); setError(''); setAlbumOpen(false); setClassificationOpen(false); setExclusion(null); if (asset.kind === 'video') setChrome(true);
    gesture.current.points.clear();
    const load = async () => {
      try {
        const shared=!retry?prefetches.current.get(asset.id):undefined;
        if(shared)span.media.source='shared';
        const ticket = await (shared?.ticket ?? mediaTicket(asset, 'original', controller.signal, span.media));
        span.log('native',controller.signal.aborted?'canceled':'ok');
        if (controller.signal.aborted) return;
        if (asset.kind !== 'video') {if(shared)await shared.decoded;else await decodeImage(ticket.url, controller.signal);span.log('decoded',controller.signal.aborted?'canceled':'ok');}
        observation.url=ticket.url;
        if (!controller.signal.aborted){if(asset.kind!=='video'){prepared.current.set(asset.id,ticket.url);while(prepared.current.size>6)prepared.current.delete(prepared.current.keys().next().value!);}setDecoded({id:asset.id,url:ticket.url});}
      } catch (reason) { if(!span.done)span.log('end',controller.signal.aborted?'canceled':'error');if (!controller.signal.aborted) setError(errorText(reason)); }
    };
    if(!prepared.current.has(asset.id)||asset.kind==='video'||retry)void load();
    return () => {controller.abort();if(!span.done)span.log('end','canceled');clearTimeout(stallTimer.current);clearTimeout(progressTimer.current);};
  }, [asset.id, asset.pending, retry]);
  useEffect(() => {autoRetry.current={id:asset.id,used:false};}, [asset.id]);
  const videoRef = useCallback((element: HTMLVideoElement | null) => {
    video.current = element;
  }, []);
  // Observe React's committed src, not setDecoded() scheduling or a screen paint.
  useLayoutEffect(() => {
    const observation=timing.current;
    if(!observation||observation.id!==asset.id||observation.span.done||!observation.url)return;
    const element=asset.kind==='video'?video.current:surface.current?.querySelector('img');
    if(element?.getAttribute('src')===observation.url)observation.span.log('commit');
  });
  useEffect(() => {setTransform({scale:1,x:0,y:0});}, [asset.id,asset.pending]);
  useEffect(() => {
    if(vault)return;
    // Skip prefetching neighbours whose decode alone would take hundreds of MB (e.g. very tall pages); they still open on demand.
    const neighbours=imageNeighbours(items,index).reverse().filter(item=>(item.size_bytes==null||item.size_bytes<=8*1024*1024)&&(!item.width||!item.height||item.width*item.height<=MAX_PREFETCH_PIXELS)).slice(0,2);
    const retained=new Set([asset.id,...neighbours.map(item=>item.id)]);
    for(const [id,work] of prefetches.current)if(!retained.has(id)){work.controller.abort();prefetches.current.delete(id);}
    if(!original)return;
    for(const neighbour of neighbours){
      if(prepared.current.has(neighbour.id)||prefetches.current.has(neighbour.id))continue;
      const controller=new AbortController();
      const span=viewerTiming(neighbour.id,neighbour.kind,false);span.log('prefetch_start');
      const ticket=mediaTicket(neighbour,'original',controller.signal,span.media);
      const decoded=ticket.then(async value=>{
        if(controller.signal.aborted)return;
        await decodeImage(value.url,controller.signal);
        if(!controller.signal.aborted){prepared.current.set(neighbour.id,value.url);while(prepared.current.size>6)prepared.current.delete(prepared.current.keys().next().value!);}
      });
      const work={controller,ticket,decoded};prefetches.current.set(neighbour.id,work);
      void decoded.then(()=>span.log('prefetch_finish',controller.signal.aborted?'canceled':'ok'),()=>span.log('prefetch_finish',controller.signal.aborted?'canceled':'error')).finally(()=>{if(prefetches.current.get(neighbour.id)===work)prefetches.current.delete(neighbour.id);});
    }
  }, [original, items, index, asset.id]);
  useEffect(() => {
    if (!chrome || filmstripActive || info || albumOpen || classificationOpen || exclusion) return;
    const timer = setTimeout(() => setChrome(false), vault ? 4000 : 2500); return () => clearTimeout(timer);
  }, [chrome, chromeActivity, filmstripActive, info, albumOpen, classificationOpen, exclusion, asset.id, vault]);
  const change = (next: number) => { if (next >= 0 && next < items.length) onIndex(next); };
  const renewVideo = (element: HTMLVideoElement | null, intendPlay: boolean) => {
    clearTimeout(progressTimer.current);
    if(element)videoResume.current={id:asset.id,time:element.currentTime,playing:intendPlay};
    if(!vault)invalidateTicket(asset, 'original');
    setRetry(value => value + 1);
  };
  /** Spends the one silent renewal of this asset; false when it was already used. */
  const autoRenew = (element: HTMLVideoElement | null) => {
    if(vault||autoRetry.current.id!==asset.id||autoRetry.current.used)return false;
    autoRetry.current.used=true;
    if(element)videoEvent(asset.id,'retry',element);
    renewVideo(element,!element||!element.paused||element.autoplay);
    return true;
  };
  const loadStart = (event: SyntheticEvent<HTMLVideoElement>) => {
    track(event);
    if(vault||!original)return;
    const element=event.currentTarget;
    clearTimeout(progressTimer.current);
    progressTimer.current=setTimeout(() => {
      if(element.readyState>=1||autoRenew(element))return;
      clearTimeout(stallTimer.current);setError('영상 연결이 지연되고 있습니다. 계속 기다리거나 다시 시도해 주세요.');
    },PROGRESS_MS);
  };
  const waiting = () => {clearTimeout(stallTimer.current);stallTimer.current=setTimeout(() => setError('영상 연결이 지연되고 있습니다. 계속 기다리거나 다시 시도해 주세요.'),15000);};
  // Library video element states go to the native perf log; vault playback stays unlogged.
  const track = (event: SyntheticEvent<HTMLVideoElement>) => {if(!vault)videoEvent(asset.id, event.type as Parameters<typeof videoEvent>[1], event.currentTarget);};
  const playing = () => {clearTimeout(stallTimer.current);setError('');};
  const distance = () => { const [a, b] = [...gesture.current.points.values()]; return a && b ? Math.hypot(a.x - b.x, a.y - b.y) : 0; };
  const clamp = (scale: number, x: number, y: number) => {
    const rect = surface.current!.getBoundingClientRect(), image = surface.current!.querySelector('img');
    const aspect = image && image.naturalHeight ? image.naturalWidth/image.naturalHeight : 1;
    return fitTransform(scale,x,y,rect.width,rect.height,aspect);
  };
  // A protected reference cannot be excluded, so the action is absent rather than refused
  // after the fact.
  const exclusionKey:ExclusionKey|null=character&&asset&&endpoint?{endpoint,libraryId:character.libraryId,targetId:character.targetId,assetId:asset.id}:null;
  const canExclude=!!exclusionKey&&!(character?.protectedAssetIds??[]).includes(asset.id);
  const openExclusion = () => {
    if(!exclusionKey||!character) return;
    setInfo(false); setAlbumOpen(false); setClassificationOpen(false); revealChrome();
    setExclusion({
      version:1,
      libraryId:character.libraryId,
      // Minted once per confirmation. A retry through the editor reuses the stored body, so a
      // lost response cannot become two exclusions.
      operationId:crypto.randomUUID(),
      targetId:character.targetId,
      assetId:asset.id,
      revision:character.revision,
    });
  };
  const imageSrc = original || asset.preview || (!vault && decoded?.id !== asset.id ? decoded?.url : undefined);
  const playerAsset = {id:asset.id,title:vault?vault.label(asset):artistLabel,originalName:vault?vault.label(asset):artistLabel,thumbnailRevision:asset.thumbnail_revision,media:{durationMs:asset.duration_ms ?? 0,scrubFrameCount:0}};
  return <Dialog open title="미디어 감상" variant="fullscreen" onClose={onClose} onKeyDown={event => {
    if (event.key === 'Escape' && info) { event.preventDefault(); setInfo(false); return; }
    if (event.target instanceof HTMLVideoElement) return;
    // Panels own their own keyboard input, so arrows inside one never change the asset.
    revealChrome();
    if (info || albumOpen || classificationOpen || exclusion) return;
    if (event.key === 'ArrowLeft') { event.preventDefault(); change(index - 1); }
    if (event.key === 'ArrowRight') { event.preventDefault(); change(index + 1); }
  }}>
    <DialogDescription className="sr-only">이미지는 두 손가락으로 확대할 수 있습니다. 좌우로 밀거나 버튼을 눌러 같은 목록의 이전·다음 자산을 봅니다. 미디어 정보를 열면 그 패널이 키보드 조작을 우선합니다.</DialogDescription>
    <div className={`viewer ${chrome ? 'chrome-visible' : ''}${asset.kind === 'video' ? ' is-video' : ''}${vault ? ' is-vault' : ''}${info && landscape && !vault ? ' has-info-panel' : ''}`}>
      <div className="viewer-main">
      <header className="viewer-bar">
        <IconButton label="뷰어 닫기" icon={ArrowLeftIcon} onClick={onClose}/>
        <span className="numeric viewer-position">{index + 1} / {total.toLocaleString('ko-KR')}</span>
        {!vault&&<div className="viewer-heading"><strong>{artistLabel}</strong>{metaLabel&&<small>{metaLabel}</small>}</div>}
        {!vault&&<span className="viewer-spacer"/>}
        <div className="viewer-actions">
          {!vault&&<>
            <ViewerAction label="앨범" icon={Square2StackIcon} active={albumOpen} onClick={() => {setInfo(false);setClassificationOpen(false);setExclusion(null);setAlbumOpen(true);revealChrome();}}/>
            <ViewerAction label="분류" icon={FolderIcon} active={classificationOpen} onClick={() => {setInfo(false);setAlbumOpen(false);setExclusion(null);setClassificationOpen(true);revealChrome();}}/>
            {canExclude&&<Button type="button" size="icon" variant="ghost" className="viewer-action viewer-action--exclude" aria-label={`${character!.name}에서 제외`} onClick={openExclusion}><UserMinusIcon aria-hidden="true"/></Button>}
            {likes.available&&<Button type="button" size="icon" variant="ghost" className="viewer-action viewer-action--like" aria-label="좋아요" aria-pressed={likes.liked.has(asset.id)} disabled={likes.pending.has(asset.id)} onClick={() => {revealChrome();void likes.toggle(asset.id);}}><HeartIcon aria-hidden="true" fill={likes.liked.has(asset.id) ? 'currentColor' : 'none'}/></Button>}
            <ViewerAction label="정보" name="미디어 정보" icon={InformationCircleIcon} active={info} onClick={() => {setAlbumOpen(false);setClassificationOpen(false);setExclusion(null);setInfo(!info); revealChrome();}}/>
            {onTrash&&!asset.pending&&<ViewerAction label="휴지통" name="휴지통으로" danger icon={TrashIcon} onClick={() => {setInfo(false);setAlbumOpen(false);setClassificationOpen(false);setExclusion(null);revealChrome();onTrash(asset);}}/>}
          </>}
        </div>
      </header>
      <div ref={surface} className={`viewer-surface ${asset.kind === 'video' ? 'is-video' : ''}${vault ? ' is-vault' : ''}`} onContextMenu={vault ? event => event.preventDefault() : undefined} onPointerDown={event => {
        if (event.button > 0 || info || albumOpen || classificationOpen || exclusion) return;
        if (chrome) revealChrome();
        event.currentTarget.setPointerCapture?.(event.pointerId);
        const g = gesture.current; g.points.set(event.pointerId, {x:event.clientX, y:event.clientY});
        if (g.points.size === 1) Object.assign(g, {startX:event.clientX, startY:event.clientY, lastX:event.clientX, lastY:event.clientY, moved:false, pinched:false});
        if (g.points.size === 2) { g.pinched=true; if(asset.kind==='video')return; g.distance = distance(); g.scale = transform.scale; g.pinched = true; }
      }} onPointerMove={event => {
        const g = gesture.current; if (!g.points.has(event.pointerId)) return;
        g.points.set(event.pointerId, {x:event.clientX, y:event.clientY});
        if (Math.hypot(event.clientX - g.startX, event.clientY - g.startY) > 8) g.moved = true;
        if (asset.kind!=='video' && g.points.size === 2 && g.distance > 0) {
          const scale = Math.min(5, Math.max(1, g.scale * distance() / g.distance));
          setTransform(current => clamp(scale,current.x,current.y));
        } else if (transform.scale > 1) {
          const rect = surface.current!.getBoundingClientRect();
          const image = surface.current!.querySelector('img');
          const aspect = image && image.naturalHeight ? image.naturalWidth / image.naturalHeight : 1;
          const fitW = Math.min(rect.width, rect.height * aspect), fitH = Math.min(rect.height, rect.width / aspect);
          const boundX = Math.max(0,(fitW * transform.scale - rect.width) / 2), boundY = Math.max(0,(fitH * transform.scale - rect.height) / 2);
          const dx = event.clientX - g.lastX, dy = event.clientY - g.lastY;
          setTransform(current => ({...current, x: Math.max(-boundX, Math.min(boundX, current.x + dx)), y: Math.max(-boundY, Math.min(boundY, current.y + dy))}));
        }
        g.lastX = event.clientX; g.lastY = event.clientY;
      }} onPointerUp={event => {
        const g = gesture.current; if (!g.points.has(event.pointerId)) return;
        g.points.delete(event.pointerId);
        if (g.points.size === 1) { const remaining = [...g.points.values()][0]; g.lastX = remaining.x; g.lastY = remaining.y; }
        const dx = event.clientX - g.startX, dy = event.clientY - g.startY;
        if (g.points.size === 0 && !g.pinched && transform.scale === 1 && Math.abs(dx) > 56 && Math.abs(dx) > Math.abs(dy) * 1.2) change(index + (dx < 0 ? 1 : -1));
        else if (g.points.size === 0 && !g.moved && !g.pinched) setChrome(value => !value);
      }} onPointerCancel={() => gesture.current.points.clear()}>
        {asset.kind === 'video' ? <VideoPlayerSurface
          key={retry}
          asset={playerAsset}
          source={vault?'vault':'library'}
          sourceUrl={original ?? null}
          poster={asset.preview}
          autoPlay={videoResume.current.id!==asset.id||videoResume.current.playing}
          loop
          preload="auto"
          controlsVisible={chrome}
          onControlsActivity={revealChrome}
          togglePlaybackOnMediaClick={false}
          scrubFrameUrlBuilder={null}
          mediaRef={videoRef}
          controlsList={vault?'nodownload noremoteplayback':undefined}
          disablePictureInPicture={!!vault||undefined}
          mediaEvents={{
            onWaiting:event => {track(event);waiting();},
            onStalled:event => {track(event);waiting();},
            onPlaying:event => {track(event);playing();},
            onCanPlay:event => {track(event);playing();},
            onLoadStart:loadStart,
            onSuspend:track,
            onAbort:track,
            onEmptied:track,
            onLoadedMetadata:event => {
              track(event);clearTimeout(progressTimer.current);const saved=videoResume.current;if(saved.id!==asset.id)return;
              event.currentTarget.currentTime=Math.min(saved.time,Number.isFinite(event.currentTarget.duration)?event.currentTarget.duration:saved.time);
              if(saved.playing)void event.currentTarget.play().catch(() => {});
            },
            onError:event => {track(event);if(original){clearTimeout(stallTimer.current);clearTimeout(progressTimer.current);if(autoRenew(event.currentTarget))return;setError(`영상을 재생하지 못했습니다. 연결 또는 지원 형식을 확인해 주세요.${vault?mediaErrorCode(event.currentTarget.error):''}`);}},
          }}
        />
          : vault ? <>
            {asset.preview && loaded !== asset.id && <img className="viewer-image viewer-placeholder" src={asset.preview} alt="" aria-hidden="true" draggable={false}/>}
            <img key={asset.id} className="viewer-image" src={original} alt={vault.label(asset)} draggable={false} onLoad={() => setLoaded(asset.id)} onError={() => setError('이미지를 표시하지 못했습니다. USB 연결과 지원 형식을 확인해 주세요.')} style={{transform:`translate(${transform.x}px, ${transform.y}px) scale(${transform.scale})`, opacity: loaded === asset.id ? undefined : 0}}/>
          </>
          : imageSrc ? <img key={asset.id} className="viewer-image" src={imageSrc} alt={artistLabel} draggable={false} style={{transform:`translate(${transform.x}px, ${transform.y}px) scale(${transform.scale})`}}/> : <div className="empty-inline">{error ? '미리보기를 표시할 수 없습니다.' : '이미지 불러오는 중'}</div>}
      </div>
      {likes.error && <div className="viewer-error" role="alert"><span>{likes.error}</span></div>}
      {error && <div className="viewer-error" role="status"><span>{error}</span><Button onClick={() => {autoRetry.current={id:asset.id,used:false};renewVideo(video.current,!!video.current&&!video.current.paused);}}><ArrowPathIcon/>다시 시도</Button></div>}
      {transform.scale > 1 && <div className="zoom-reset"><IconButton label="화면에 맞추기" icon={MagnifyingGlassMinusIcon} onClick={() => setTransform({scale:1,x:0,y:0})}/></div>}
      {!vault&&<ViewerFilmstrip items={items} index={index} privacy={privacy} onIndex={change} onInteract={revealChrome} onInteractionChange={setFilmstripActive}/>}
      {vault&&<footer className="viewer-bar"><IconButton label="이전 자산" icon={ChevronLeftIcon} disabled={index === 0} onClick={() => change(index - 1)}/><span className="viewer-title">{vault.label(asset)}</span><IconButton label="다음 자산" icon={ChevronRightIcon} disabled={index === items.length - 1} onClick={() => change(index + 1)}/></footer>}
      {!vault&&<nav className="viewer-nav-a11y" aria-label="자산 이동"><button type="button" aria-label="이전 자산" disabled={index === 0} onClick={() => change(index - 1)}>이전 자산</button><button type="button" aria-label="다음 자산" disabled={index === items.length - 1} onClick={() => change(index + 1)}>다음 자산</button></nav>}
      </div>
      {!vault&&info&&landscape&&<aside className="viewer-info-dock" aria-label="미디어 정보"><ViewerInfo asset={asset} mediaError={error} onClose={() => setInfo(false)}/></aside>}
      {!vault&&<>
      <AlbumMembershipEditor assetId={asset.id} open={albumOpen} onClose={()=>setAlbumOpen(false)}/>
      <ClassificationAssignmentEditor assetId={asset.id} open={classificationOpen} onClose={()=>setClassificationOpen(false)}/>
      <CharacterExclusionEditor request={exclusion} target={exclusionKey} characterName={character?.name||'이 캐릭터'} assetLabel={asset.creator_name||asset.creator_handle||'이 자산'} onClose={()=>setExclusion(null)} onExcluded={receipt=>{setExclusion(null);onCharacterExcluded?.(receipt);}}/>
      {trashNotice}
      {info&&!landscape&&<BottomSheet title="미디어 정보" onClose={() => setInfo(false)}><ViewerInfo asset={asset} mediaError={error} onClose={() => setInfo(false)}/></BottomSheet>}
      </>}
    </div>
  </Dialog>;
}

/** How long a library video may go from loadstart to loadedmetadata before it is renewed. */
const PROGRESS_MS = 8000;
// About 96 MB once decoded as RGBA; larger neighbours are not prefetched.
const MAX_PREFETCH_PIXELS = 24_000_000;

/**
 * The media element's own error class for a vault video, e.g. ` (오류 2 · PIPELINE_ERROR_READ)`.
 * Only the code and Chromium's leading error name are kept: never a URL or file detail.
 */
function mediaErrorCode(error: MediaError | null) {
  if (!error) return '';
  const name = /^[A-Z][A-Z0-9_]+/.exec(error.message ?? '')?.[0];
  console.warn(`vault video error ${error.code}${name ? ` ${name}` : ''}`);
  return ` (오류 ${error.code}${name ? ` · ${name}` : ''})`;
}
