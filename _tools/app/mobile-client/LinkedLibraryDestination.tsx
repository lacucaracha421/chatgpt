import {useEffect, useRef, useState} from 'react';
import {Artists} from './Artists';
import {CharacterBrowser} from './CharacterBrowser';
import {Viewer} from './Viewer';
import {TopBar} from './TopBar';
import {Button, Dialog, DialogDescription} from './ui';
import {BusyLabel} from '../src/shared/ui/BusyLabel';
import {useAndroidBack} from './cards/useAndroidBack';
import {api, errorText} from './transport';
import type {LibraryArtist} from './artistsModel';
import type {CharacterIndex} from './characterModel';
import type {Asset, Classification, PageWire} from './types';
import {DEFAULT_DENSITY} from './model';
import './LinkedLibraryDestination.css';

export type LinkedDestination = {kind:'asset';id:string} | {kind:'character';id:string} | {kind:'artist';artist:LibraryArtist};

/** The existing listing is cursor-paged; it has no single-Asset metadata route. */
export async function findLinkedAsset(id:string, known:readonly Asset[], signal:AbortSignal):Promise<Asset> {
  const loaded=known.find(asset=>asset.id===id);
  if(loaded)return loaded;
  let cursor:string|null=null;
  do {
    const page:PageWire=await api<PageWire>(`/v1/library/assets?limit=200${cursor?`&cursor=${encodeURIComponent(cursor)}`:''}`,signal);
    if(signal.aborted)throw new DOMException('Cancelled','AbortError');
    const asset=page.items.find(item=>item.id===id);
    if(asset)return asset;
    cursor=page.has_more?page.next_cursor:null;
  } while(cursor);
  throw new Error('원본 에셋을 찾을 수 없습니다. 삭제되었거나 현재 공유되지 않은 에셋입니다.');
}

/** Keep the originating viewer/sheet/album mounted, including its selection and scroll. */
export function LinkedLibraryDestination({target,endpoint,classifications,knownAssets,onClose}:{target:LinkedDestination;endpoint:string;classifications:readonly Classification[];knownAssets:readonly Asset[];onClose():void}) {
  const [viewer,setViewer]=useState<{items:Asset[];index:number}|null>(null);
  const [node,setNode]=useState<string|null>(null),[error,setError]=useState(''),[retry,setRetry]=useState(0);
  const [nextDestination,setNextDestination]=useState<LinkedDestination|null>(null);
  const artist=target.kind==='artist'?target.artist:null;
  const destinationBack=useRef<(()=>boolean)|null>(null),viewerBack=useRef<(()=>boolean)|null>(null);
  const known=useRef(knownAssets);known.current=knownAssets;
  useEffect(()=>{
    const controller=new AbortController();setError('');
    if(target.kind==='asset')void findLinkedAsset(target.id,known.current,controller.signal).then(asset=>{if(!controller.signal.aborted)setViewer({items:[asset],index:0});},reason=>{if(!controller.signal.aborted)setError(errorText(reason));});
    if(target.kind==='character')void api<CharacterIndex>('/v1/library/characters',controller.signal).then(index=>{
      if(controller.signal.aborted)return;
      const match=index.nodes.find(item=>item.kind==='character'&&(item.sourceId===target.id||item.id===target.id));
      if(!match)throw new Error('캐릭터 폴더가 아직 공유되지 않았습니다.');
      setNode(match.id);
    }).catch(reason=>{if(!controller.signal.aborted)setError(errorText(reason));});
    return()=>controller.abort();
  },[target,retry]);
  const closeViewer=()=>{if(target.kind==='asset'&&!artist)onClose();else setViewer(null);};
  const back=()=>{
    if(viewer){if(!viewerBack.current?.())closeViewer();return;}
    if(!destinationBack.current?.())onClose();
  };
  useAndroidBack(back);
  return <Dialog open variant="fullscreen" layer title="라이브러리" onClose={back}>
    <DialogDescription className="sr-only">뒤로 가면 이전 화면으로 돌아갑니다.</DialogDescription>
    <div className="linked-library-destination">
      {artist?<Artists key={artist.id} endpoint={endpoint} initialArtist={artist} backRef={destinationBack} onClose={onClose} paused={!!viewer} onOpenViewer={(items,index)=>setViewer({items,index})}/>
        :target.kind==='character'&&node?<CharacterBrowser active paused={!!viewer} classifications={classifications} initialNode={node} density={DEFAULT_DENSITY} refreshKey={0} backRef={destinationBack} onExit={onClose} onOpen={(items,index)=>setViewer({items,index})}/>
        :<><TopBar title={target.kind==='asset'?'원본 에셋':'캐릭터 폴더'} back={{label:'이전 화면으로',onClick:onClose}}/><BusyLabel busy={!error}>불러오는 중</BusyLabel>{error&&<p role="alert">{error}<Button onClick={()=>setRetry(value=>value+1)}>다시 시도</Button></p>}</>}
      {viewer&&<Viewer items={viewer.items} index={viewer.index} onIndex={index=>setViewer({...viewer,index})} onClose={closeViewer} endpoint={endpoint} backRef={viewerBack} classifications={classifications} onArtist={value=>setNextDestination({kind:'artist',artist:value})}/>}
      {nextDestination&&<LinkedLibraryDestination target={nextDestination} endpoint={endpoint} classifications={classifications} knownAssets={viewer?.items??knownAssets} onClose={()=>setNextDestination(null)}/>}
    </div>
  </Dialog>;
}
