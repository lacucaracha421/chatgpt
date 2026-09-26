import { useEffect, useRef, useState } from "react";
import { acquireCover, coverKey, coverSourceUrl, type CoverRequest } from "./collectibleRuntime";
import type { Snapshot } from "./RenderCache";
import { observeCover, observeCoverSize } from "./coverVisibility";
import "./physicalCollections.css";
export type PhysicalCoverProps = {
  src:string|null; alt:string; kind:"book"|"game"; scope?:string; revision?:string; large?:boolean; onError?:()=>void;
};
/**
 * While a render is pending the cover shows a neutral object of the final silhouette (the cached
 * neutral case for games, a CSS book shape for manga), never the flat source, and the finished render
 * fades in over it. Only a failed or unavailable render falls back to the flat source.
 */
export function PhysicalCover({src,alt,kind,scope="",revision="",large=false,onError}:PhysicalCoverProps) {
  const root=useRef<HTMLSpanElement>(null), latestError=useRef(onError), onScreen=useRef(false); latestError.current=onError;
  const [near,setNear]=useState(false),[pixels,setPixels]=useState(large?320:256);
  const [result,setResult]=useState<{key:string;value:Snapshot;failed:boolean;instant:boolean}|null>(null);
  const [shell,setShell]=useState<Snapshot>(null);
  const [loadedUrl,setLoadedUrl]=useState<string|null>(null);
  const request:CoverRequest={kind,src:src??"",scope,revision,pixels},key=coverKey(request);
  const current=result?.key===key?result:null;
  useEffect(()=>root.current?observeCover(root.current,(isNear,isVisible)=>{onScreen.current=isVisible;setNear(isNear);}):undefined,[]);
  useEffect(()=>{
    if(kind!=="game"||!root.current) {setPixels(large?320:256);return;}
    const update=(width:number)=>{
      const required=Math.max(1,width)*Math.min(window.devicePixelRatio||1,2);
      setPixels([192,256,320,384,512].find(size=>size>=required)??512);
    };
    return observeCoverSize(root.current,update);
  },[kind,large]);
  // One shared neutral case per pixel bucket: the pending silhouette of every game, and the final image without artwork.
  useEffect(()=>{
    if(!near||kind!=="game") return;
    let active=true;
    const stop=acquireCover({kind,src:"",scope:"neutral-shell",revision:"",pixels},value=>{if(active)setShell(value);});
    return ()=>{active=false;stop();setShell(null);};
  },[near,kind,pixels]);
  useEffect(()=>{
    if(!near||!src) return;
    let active=true,instant=true;
    const stop=acquireCover({kind,src,scope,revision,pixels},value=>{if(active)setResult({key,value,failed:value===null,instant});},()=>onScreen.current?0:1);
    instant=false;
    return ()=>{active=false;stop();setResult(null);};
  },[near,key,kind,src,scope,revision,pixels]);
  const art=src?current?.value??null:shell;
  const fallback=Boolean(src&&current?.failed);
  const url=near?(art?.url??(fallback?coverSourceUrl(request):null)):null;
  const ready=url!==null&&loadedUrl===url;
  const showShell=near&&kind==="game"&&Boolean(src)&&!fallback&&Boolean(shell);
  return <span ref={root} className={`physical-cover physical-cover--${kind}`} data-ready={ready} data-source={art?"rendered":fallback?"fallback":"pending"}
    data-shell={showShell||undefined} data-instant={(src&&current?.instant)||undefined}>
    {showShell&&<img className="physical-cover__shell" src={shell!.url} alt="" aria-hidden="true" decoding="async" draggable={false} />}
    <img className="physical-cover__image" src={url??undefined} crossOrigin="anonymous" alt={alt} decoding="async" draggable={false}
      onLoad={()=>setLoadedUrl(url)}
      onError={()=>{
        if(src&&art) setResult({key,value:null,failed:true,instant:true});
        else latestError.current?.();
      }} />
  </span>;
}
