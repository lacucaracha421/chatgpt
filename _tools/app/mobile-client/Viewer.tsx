import {useEffect, useLayoutEffect, useRef, useState} from 'react';
import {ArrowLeftIcon, ChevronLeftIcon, ChevronRightIcon, InformationCircleIcon, ArrowPathIcon, MagnifyingGlassMinusIcon, FolderIcon, TagIcon, TrashIcon} from '@heroicons/react/24/outline';
import {Dialog, DialogDescription, IconButton, Button} from './ui';
import type {Asset} from './types';
import {dateLabel, imageNeighbours, fitTransform} from './model';
import {decodeImage, invalidateTicket, mediaTicket} from './media';
import {errorText} from './transport';
import {viewerTiming} from './perf';
import {AlbumMembershipEditor} from './AlbumMembershipEditor';
import {ClassificationAssignmentEditor} from './ClassificationAssignmentEditor';
import {CharacterExclusionEditor, type ExclusionRequest, type ExclusionKey, type ExclusionReceipt} from './CharacterExclusion';
import {ViewerInfo} from './ViewerInfo';
import {CharacterAddSheet} from './CharacterAddSheet';

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

export function Viewer({items, index, onIndex, onClose,onNearEnd,backRef,endpoint,character,onCharacterExcluded,reviewLibrary,onTrash,trashNotice,vault}: {items: Asset[]; index: number; onIndex(index: number): void; onClose(): void;onNearEnd?():void;backRef?: React.MutableRefObject<(() => boolean) | null>;endpoint?:string;character?:ViewerCharacterContext|null;onCharacterExcluded?(receipt:ExclusionReceipt):void;
  /** The library character-review decisions go to; set only when a PC adopted review. */
  reviewLibrary?:string|null;
  /** Move the Asset on screen to the Library Trash (no confirmation: it is reversible). */
  onTrash?(asset:Asset):void;
  /** The host's "휴지통으로 이동함 · 실행 취소" snackbar, rendered inside the modal viewer. */
  trashNotice?:React.ReactNode;
  /** Private Vault mode: same gestures, chrome and video controls; no library media or actions. */
  vault?:ViewerVaultSource}) {
  const asset = items[index];
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
  // Viewer "캐릭터에 추가" sheet and the note shown after a decision was queued.
  const [addOpen,setAddOpen]=useState(false);
  const [added,setAdded]=useState('');
  const addOpenRef=useRef(false);
  addOpenRef.current=addOpen;
  useEffect(() => {
    if (!backRef) return;
    backRef.current = () => {
      // The confirmation is the innermost overlay, so it consumes Back first: dismissing it
      // leaves the viewer open with its media untouched, which is what "취소" means here.
      if (exclusionOpen.current) { setExclusion(null); return true; }
      if (addOpenRef.current) { setAddOpen(false); return true; }
      if (infoOpen.current) { setInfo(false); return true; }
      return false;
    };
    return () => { backRef.current = null; };
  }, [backRef]);
  const [albumOpen, setAlbumOpen] = useState(false);
  const [classificationOpen, setClassificationOpen] = useState(false);
  const [chrome, setChrome] = useState(true);
  const [transform, setTransform] = useState({scale: 1, x: 0, y: 0});
  const surface = useRef<HTMLDivElement>(null);
  const video = useRef<HTMLVideoElement>(null);
  const videoResume = useRef({id:'',time:0,playing:false});
  const stallTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const gesture = useRef({points: new Map<number, {x: number; y: number}>(), startX: 0, startY: 0, distance: 0, scale: 1, lastX: 0, lastY: 0, moved: false, pinched: false});
  useEffect(() => {
    if (vault) {
      timing.current = undefined; setLoaded(''); setError(''); setChrome(true); gesture.current.points.clear();
      return () => clearTimeout(stallTimer.current);
    }
    const controller = new AbortController();
    const fromPrepared=prepared.current.has(asset.id)&&asset.kind!=='video'&&!retry;
    const span=viewerTiming(asset.id,asset.kind,fromPrepared);
    const observation={id:asset.id,url:fromPrepared?prepared.current.get(asset.id):undefined,span};
    timing.current=observation;
    span.log('open');
    setDecoded(prepared.current.has(asset.id)?{id:asset.id,url:prepared.current.get(asset.id)!}:undefined); setError(''); setInfo(false); setAlbumOpen(false); setClassificationOpen(false); setExclusion(null); setAddOpen(false); setAdded(''); setChrome(true);
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
    return () => {controller.abort();if(!span.done)span.log('end','canceled');clearTimeout(stallTimer.current);};
  }, [asset.id, asset.pending, retry]);
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
    const neighbours=imageNeighbours(items,index).reverse().filter(item=>(item.size_bytes==null||item.size_bytes<=8*1024*1024)).slice(0,2);
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
    if (!chrome || info || albumOpen || classificationOpen || exclusion || addOpen || asset.kind === 'video') return;
    const timer = setTimeout(() => setChrome(false), 4000); return () => clearTimeout(timer);
  }, [chrome, info, albumOpen, classificationOpen, exclusion, addOpen, asset.id, asset.kind]);
  const change = (next: number) => { if (next >= 0 && next < items.length) onIndex(next); };
  const waiting = () => {clearTimeout(stallTimer.current);stallTimer.current=setTimeout(() => setError('영상 연결이 지연되고 있습니다. 계속 기다리거나 다시 시도해 주세요.'),15000);};
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
    setInfo(false); setAlbumOpen(false); setClassificationOpen(false); setChrome(true);
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
  return <Dialog open title="미디어 감상" variant="fullscreen" onClose={onClose} onKeyDown={event => {
    if (event.target instanceof HTMLVideoElement) return;
    // Panels own their own keyboard input, so arrows inside one never change the asset.
    if (info || albumOpen || classificationOpen || exclusion || addOpen) return;
    if (event.key === 'ArrowLeft') { event.preventDefault(); change(index - 1); }
    if (event.key === 'ArrowRight') { event.preventDefault(); change(index + 1); }
  }}>
    <DialogDescription className="sr-only">이미지는 두 손가락으로 확대할 수 있습니다. 좌우로 밀거나 버튼을 눌러 같은 목록의 이전·다음 자산을 봅니다. 미디어 정보를 열면 그 패널이 키보드 조작을 우선합니다.</DialogDescription>
    <div className={`viewer ${chrome ? 'chrome-visible' : ''}${asset.kind === 'video' ? ' is-video' : ''}`}>
      <header className="viewer-bar"><IconButton label="뷰어 닫기" icon={ArrowLeftIcon} onClick={onClose}/><span className="numeric">{index + 1} / {items.length}</span><div className="viewer-actions">{!vault&&<>{reviewLibrary&&!asset.pending&&<Button size="sm" variant="ghost" onClick={()=>{setInfo(false);setAlbumOpen(false);setClassificationOpen(false);setExclusion(null);setAdded('');setAddOpen(true);setChrome(true);}}>캐릭터에 추가</Button>}{canExclude&&<Button size="sm" variant="ghost" onClick={openExclusion}>{`${character!.name}에서 제외`}</Button>}<IconButton label="분류" icon={TagIcon} active={classificationOpen} onClick={() => {setInfo(false);setAlbumOpen(false);setExclusion(null);setClassificationOpen(true);setChrome(true);}}/><IconButton label="앨범" icon={FolderIcon} active={albumOpen} onClick={() => {setInfo(false);setClassificationOpen(false);setExclusion(null);setAlbumOpen(true);setChrome(true);}}/><IconButton label="미디어 정보" icon={InformationCircleIcon} active={info} onClick={() => {setAlbumOpen(false);setClassificationOpen(false);setExclusion(null);setInfo(!info); setChrome(true);}}/>{onTrash&&!asset.pending&&<IconButton label="휴지통으로" icon={TrashIcon} onClick={() => {setInfo(false);setAlbumOpen(false);setClassificationOpen(false);setExclusion(null);setAddOpen(false);setChrome(true);onTrash(asset);}}/>}</>}</div></header>
      <div ref={surface} className={`viewer-surface ${asset.kind === 'video' ? 'is-video' : ''}${vault ? ' is-vault' : ''}`} onContextMenu={vault ? event => event.preventDefault() : undefined} onPointerDown={event => {
        if (event.button > 0 || info || albumOpen || classificationOpen || exclusion || addOpen) return;
        if(asset.kind==='video'&&video.current){const rect=video.current.getBoundingClientRect();if(event.clientY>rect.bottom-64)return;}
        if(asset.kind!=='video')event.currentTarget.setPointerCapture?.(event.pointerId);
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
        else if (asset.kind!=='video' && g.points.size === 0 && !g.moved && !g.pinched) setChrome(value => !value);
      }} onPointerCancel={() => gesture.current.points.clear()}>
        {asset.kind === 'video' ? <video ref={video} key={`${asset.id}:${retry}`} src={original} poster={asset.preview} controls autoPlay={videoResume.current.id!==asset.id||videoResume.current.playing} loop playsInline preload="auto" onWaiting={waiting} onStalled={waiting} onPlaying={playing} onCanPlay={playing} onLoadedMetadata={event => {
          const saved=videoResume.current;if(saved.id!==asset.id)return;
          event.currentTarget.currentTime=Math.min(saved.time,Number.isFinite(event.currentTarget.duration)?event.currentTarget.duration:saved.time);
          if(saved.playing)void event.currentTarget.play().catch(() => {});
        }} onError={event => {if(original){clearTimeout(stallTimer.current);setError(`영상을 재생하지 못했습니다. 연결 또는 지원 형식을 확인해 주세요.${vault?mediaErrorCode(event.currentTarget.error):''}`);}}} {...(vault?{controlsList:'nodownload noremoteplayback',disablePictureInPicture:true}:{})}/>
          : vault ? <>
            {asset.preview && loaded !== asset.id && <img className="viewer-image viewer-placeholder" src={asset.preview} alt="" aria-hidden="true" draggable={false}/>}
            <img key={asset.id} className="viewer-image" src={original} alt={vault.label(asset)} draggable={false} onLoad={() => setLoaded(asset.id)} onError={() => setError('이미지를 표시하지 못했습니다. USB 연결과 지원 형식을 확인해 주세요.')} style={{transform:`translate(${transform.x}px, ${transform.y}px) scale(${transform.scale})`, opacity: loaded === asset.id ? undefined : 0}}/>
          </>
          : (original || asset.preview) ? <img key={asset.id} className="viewer-image" src={original || asset.preview} alt={asset.creator_name || asset.creator_handle || '저장한 이미지'} draggable={false} style={{transform:`translate(${transform.x}px, ${transform.y}px) scale(${transform.scale})`}}/> : <div className="empty-inline">{error ? '미리보기를 표시할 수 없습니다.' : '이미지 불러오는 중'}</div>}
      </div>
      {error && <div className="viewer-error" role="status"><span>{error}</span><Button onClick={() => {if(video.current)videoResume.current={id:asset.id,time:video.current.currentTime,playing:!video.current.paused};if(!vault)invalidateTicket(asset, 'original'); setRetry(value => value + 1);}}><ArrowPathIcon/>다시 시도</Button></div>}
      {transform.scale > 1 && <div className="zoom-reset"><IconButton label="화면에 맞추기" icon={MagnifyingGlassMinusIcon} onClick={() => setTransform({scale:1,x:0,y:0})}/></div>}
      <footer className="viewer-bar"><IconButton label="이전 자산" icon={ChevronLeftIcon} disabled={index === 0} onClick={() => change(index - 1)}/><span className={vault ? 'viewer-title' : undefined}>{vault ? vault.label(asset) : asset.pending ? '처리 대기' : dateLabel(asset)}</span><IconButton label="다음 자산" icon={ChevronRightIcon} disabled={index === items.length - 1} onClick={() => change(index + 1)}/></footer>
      {!vault&&<>
      <AlbumMembershipEditor assetId={asset.id} open={albumOpen} onClose={()=>setAlbumOpen(false)}/>
      <ClassificationAssignmentEditor assetId={asset.id} open={classificationOpen} onClose={()=>setClassificationOpen(false)}/>
      <CharacterExclusionEditor request={exclusion} target={exclusionKey} characterName={character?.name||'이 캐릭터'} assetLabel={asset.creator_name||asset.creator_handle||'이 자산'} onClose={()=>setExclusion(null)} onExcluded={receipt=>{setExclusion(null);onCharacterExcluded?.(receipt);}}/>
      {added && <div className="viewer-error" role="status"><span>{added}</span></div>}
      {trashNotice}
      {addOpen&&reviewLibrary&&<CharacterAddSheet assetId={asset.id} libraryId={reviewLibrary} onClose={()=>setAddOpen(false)} onAdded={name=>{setAddOpen(false);setAdded(`${name}에 추가했습니다 · PC 반영 대기`);}}/>}
      {info && <Dialog open title="미디어 정보" variant="wide" onClose={() => setInfo(false)}><DialogDescription className="sr-only">작가, 출처와 파일 정보를 확인하고 텍스트로 복사합니다.</DialogDescription><ViewerInfo asset={asset} mediaError={error} onClose={() => setInfo(false)}/></Dialog>}
      </>}
    </div>
  </Dialog>;
}

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
