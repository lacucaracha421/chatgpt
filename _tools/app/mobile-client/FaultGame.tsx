import {useEffect,useRef,useState} from 'react';
import {Button} from './ui';
import {mediaTicket} from './media';
import {mapBounded} from './model';
import type {Asset} from './types';
import {connectFaultFrame,faultCandidates,faultGameUrl,pickRandom,type FaultPhoto} from '../src/games/fault/host';
import './fault.css';

/**
 * Up to 24 random images of the scope, read through the same original-media tickets as the
 * viewer. Unreadable images are skipped; an empty result means nothing could be read.
 */
export async function loadFaultPhotos(items:readonly Asset[],signal?:AbortSignal,random:()=>number=Math.random):Promise<FaultPhoto[]> {
  const chosen=pickRandom(faultCandidates(items),undefined,random);
  const loaded=await mapBounded(chosen,3,async asset=>{
    try {
      const ticket=await mediaTicket(asset,'original',signal);
      const response=await fetch(ticket.url,{signal});
      if(!response.ok)return null;
      const data=await response.blob();
      if(!data.size)return null;
      // The game checks the declared type before converting, so a typeless body gets the asset's.
      const blob=data.type?data:data.slice(0,data.size,asset.content_type||'image/jpeg');
      return {id:asset.id,blob} satisfies FaultPhoto;
    } catch(error) { if(signal?.aborted)throw error; return null; }
  },signal);
  return loaded.filter((photo):photo is {id:string;blob:Blob}=>photo!==null);
}

/** Full-screen host for the bundled game; the photos live only as long as this overlay. */
export function FaultGame({items,onClose}:{items:readonly Asset[];onClose():void}) {
  const frame=useRef<HTMLIFrameElement>(null);
  const [state,setState]=useState<'loading'|'playing'|'failed'>('loading');
  const scope=useRef(items),close=useRef(onClose);close.current=onClose;
  useEffect(()=>{
    const controller=new AbortController();
    const link=connectFaultFrame({game:()=>frame.current?.contentWindow??null,onClose:()=>close.current()});
    void loadFaultPhotos(scope.current,controller.signal).then(photos=>{
      if(controller.signal.aborted)return;
      if(!photos.length){setState('failed');return;}
      link.supply(photos);setState('playing');
    },()=>{if(!controller.signal.aborted)setState('failed');});
    return()=>{controller.abort();link.dispose();};
  },[]);
  return <div className="fault-overlay" role="dialog" aria-modal="true" aria-label="FAULT">
    <iframe ref={frame} className="fault-frame" src={faultGameUrl()} title="FAULT — REVEAL" allow="fullscreen; screen-wake-lock; autoplay" onLoad={()=>frame.current?.contentWindow?.focus()}/>
    {state!=='playing'&&<div className="fault-status" role={state==='failed'?'alert':'status'}>
      <p>{state==='loading'?'사진을 준비하고 있습니다':'사진을 불러오지 못했습니다'}</p>
      {state==='loading'&&<div className="loading-line" aria-hidden="true"/>}
      <Button variant="ghost" onClick={()=>close.current()}>닫기</Button>
    </div>}
  </div>;
}
