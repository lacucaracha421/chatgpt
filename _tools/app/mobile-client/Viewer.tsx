import {useEffect, useRef, useState} from 'react';
import {ArrowLeftIcon, ChevronLeftIcon, ChevronRightIcon, InformationCircleIcon, ArrowPathIcon, MagnifyingGlassMinusIcon, FolderIcon, TagIcon} from '@heroicons/react/24/outline';
import {Dialog, DialogDescription, IconButton, Button} from './ui';
import type {Asset} from './types';
import {dateLabel, imageNeighbours, fitTransform} from './model';
import {decodeImage, invalidateTicket, mediaTicket} from './media';
import {errorText} from './transport';
import {AlbumMembershipEditor} from './AlbumMembershipEditor';
import {ClassificationAssignmentEditor} from './ClassificationAssignmentEditor';
import {CharacterExclusionEditor, type ExclusionRequest, type ExclusionKey, type ExclusionReceipt} from './CharacterExclusion';
import {ViewerInfo} from './ViewerInfo';

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
export type ViewerCharacterContext = {targetId:string;name:string;libraryId:string;revision:string;protectedAssetIds:string[]};

export function Viewer({items, index, onIndex, onClose,onNearEnd,backRef,endpoint,character,onCharacterExcluded}: {items: Asset[]; index: number; onIndex(index: number): void; onClose(): void;onNearEnd?():void;backRef?: React.MutableRefObject<(() => boolean) | null>;endpoint?:string;character?:ViewerCharacterContext|null;onCharacterExcluded?(receipt:ExclusionReceipt):void}) {
  const asset = items[index];
  useEffect(()=>{if(index>=items.length-3)onNearEnd?.();},[index,items.length,onNearEnd]);
  const prepared=useRef(new Map<string,string>());
  const [decoded, setDecoded] = useState<{id: string; url: string}>();
  const original = decoded?.id === asset.id ? decoded.url : prepared.current.get(asset.id);
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
    const controller = new AbortController();
    setDecoded(prepared.current.has(asset.id)?{id:asset.id,url:prepared.current.get(asset.id)!}:undefined); setError(''); setInfo(false); setAlbumOpen(false); setClassificationOpen(false); setExclusion(null); setChrome(true);
    gesture.current.points.clear();
    const load = async () => {
      try {
        const ticket = await mediaTicket(asset, 'original', controller.signal);
        if (controller.signal.aborted) return;
        if (asset.kind !== 'video') await decodeImage(ticket.url, controller.signal);
        if (!controller.signal.aborted){if(asset.kind!=='video'){prepared.current.set(asset.id,ticket.url);while(prepared.current.size>6)prepared.current.delete(prepared.current.keys().next().value!);}setDecoded({id:asset.id,url:ticket.url});}
      } catch (reason) { if (!controller.signal.aborted) setError(errorText(reason)); }
    };
    if(!prepared.current.has(asset.id)||asset.kind==='video'||retry)void load();
    return () => {controller.abort();clearTimeout(stallTimer.current);};
  }, [asset.id, asset.pending, retry]);
  useEffect(() => {setTransform({scale:1,x:0,y:0});}, [asset.id,asset.pending]);
  useEffect(() => {
    if (!original) return;
    const controller = new AbortController();
    for (const neighbour of imageNeighbours(items, index).reverse().filter(item => (item.size_bytes == null || item.size_bytes <= 8*1024*1024)&&!prepared.current.has(item.id)).slice(0,2)) {
      void mediaTicket(neighbour, 'original', controller.signal).then(ticket => {
        if (!controller.signal.aborted) return decodeImage(ticket.url, controller.signal).then(()=>{if(!controller.signal.aborted){prepared.current.set(neighbour.id,ticket.url);while(prepared.current.size>6)prepared.current.delete(prepared.current.keys().next().value!);}});
      }).catch(() => {});
    }
    return () => controller.abort();
  }, [original, items, index]);
  useEffect(() => {
    if (!chrome || info || albumOpen || classificationOpen || exclusion || asset.kind === 'video') return;
    const timer = setTimeout(() => setChrome(false), 4000); return () => clearTimeout(timer);
  }, [chrome, info, albumOpen, classificationOpen, exclusion, asset.id, asset.kind]);
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
    if (info || albumOpen || classificationOpen || exclusion) return;
    if (event.key === 'ArrowLeft') { event.preventDefault(); change(index - 1); }
    if (event.key === 'ArrowRight') { event.preventDefault(); change(index + 1); }
  }}>
    <DialogDescription className="sr-only">이미지는 두 손가락으로 확대할 수 있습니다. 좌우로 밀거나 버튼을 눌러 같은 목록의 이전·다음 자산을 봅니다. 미디어 정보를 열면 그 패널이 키보드 조작을 우선합니다.</DialogDescription>
    <div className={`viewer ${chrome ? 'chrome-visible' : ''}`}>
      <header className="viewer-bar"><IconButton label="뷰어 닫기" icon={ArrowLeftIcon} onClick={onClose}/><span className="numeric">{index + 1} / {items.length}</span><div className="viewer-actions">{canExclude&&<Button size="sm" variant="ghost" onClick={openExclusion}>{`${character!.name}에서 제외`}</Button>}<IconButton label="분류" icon={TagIcon} active={classificationOpen} onClick={() => {setInfo(false);setAlbumOpen(false);setExclusion(null);setClassificationOpen(true);setChrome(true);}}/><IconButton label="앨범" icon={FolderIcon} active={albumOpen} onClick={() => {setInfo(false);setClassificationOpen(false);setExclusion(null);setAlbumOpen(true);setChrome(true);}}/><IconButton label="미디어 정보" icon={InformationCircleIcon} active={info} onClick={() => {setAlbumOpen(false);setClassificationOpen(false);setExclusion(null);setInfo(!info); setChrome(true);}}/></div></header>
      <div ref={surface} className={`viewer-surface ${asset.kind === 'video' ? 'is-video' : ''}`} onPointerDown={event => {
        if (event.button > 0 || info || albumOpen || classificationOpen || exclusion) return;
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
        }} onError={() => {if(original){clearTimeout(stallTimer.current);setError('영상을 재생하지 못했습니다. 연결 또는 지원 형식을 확인해 주세요.');}}}/>
          : (original || asset.preview) ? <img key={asset.id} className="viewer-image" src={original || asset.preview} alt={asset.creator_name || asset.creator_handle || '저장한 이미지'} draggable={false} style={{transform:`translate(${transform.x}px, ${transform.y}px) scale(${transform.scale})`}}/> : <div className="empty-inline">{error ? '미리보기를 표시할 수 없습니다.' : '이미지 불러오는 중'}</div>}
      </div>
      {error && <div className="viewer-error" role="status"><span>{error}</span><Button onClick={() => {if(video.current)videoResume.current={id:asset.id,time:video.current.currentTime,playing:!video.current.paused};invalidateTicket(asset, 'original'); setRetry(value => value + 1);}}><ArrowPathIcon/>다시 시도</Button></div>}
      {transform.scale > 1 && <div className="zoom-reset"><IconButton label="화면에 맞추기" icon={MagnifyingGlassMinusIcon} onClick={() => setTransform({scale:1,x:0,y:0})}/></div>}
      <footer className="viewer-bar"><IconButton label="이전 자산" icon={ChevronLeftIcon} disabled={index === 0} onClick={() => change(index - 1)}/><span>{asset.pending ? '처리 대기' : dateLabel(asset)}</span><IconButton label="다음 자산" icon={ChevronRightIcon} disabled={index === items.length - 1} onClick={() => change(index + 1)}/></footer>
      <AlbumMembershipEditor assetId={asset.id} open={albumOpen} onClose={()=>setAlbumOpen(false)}/>
      <ClassificationAssignmentEditor assetId={asset.id} open={classificationOpen} onClose={()=>setClassificationOpen(false)}/>
      <CharacterExclusionEditor request={exclusion} target={exclusionKey} characterName={character?.name||'이 캐릭터'} assetLabel={asset.creator_name||asset.creator_handle||'이 자산'} onClose={()=>setExclusion(null)} onExcluded={receipt=>{setExclusion(null);onCharacterExcluded?.(receipt);}}/>
      {info && <Dialog open title="미디어 정보" variant="wide" onClose={() => setInfo(false)}><DialogDescription className="sr-only">작가, 출처와 파일 정보를 확인하고 텍스트로 복사합니다.</DialogDescription><ViewerInfo asset={asset} mediaError={error} onClose={() => setInfo(false)}/></Dialog>}
    </div>
  </Dialog>;
}
