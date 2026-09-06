import { useEffect, useRef, useState } from "react";
import { acquireCover, coverKey, type CoverRequest } from "./collectibleRuntime";
import type { Snapshot } from "./RenderCache";
import { observeCover, observeCoverSize } from "./coverVisibility";
import "./physicalCollections.css";
export type PhysicalCoverProps = {
  src:string|null; alt:string; kind:"book"|"game"; scope?:string; revision?:string; large?:boolean; onError?:()=>void;
};
export function PhysicalCover({src,alt,kind,scope="",revision="",large=false,onError}:PhysicalCoverProps) {
  const root=useRef<HTMLSpanElement>(null), latestError=useRef(onError); latestError.current=onError;
  const [near,setNear]=useState(false),[pixels,setPixels]=useState(large?320:256);
  const [result,setResult]=useState<{key:string;value:Snapshot;failed:boolean}|null>(null);
  const [shell,setShell]=useState<Snapshot>(null);
  const request:CoverRequest={kind,src:src??"",scope,revision,pixels},key=coverKey(request);
  const current=result?.key===key?result:null;
  useEffect(()=>root.current?observeCover(root.current,setNear):undefined,[]);
  useEffect(()=>{
    if(kind!=="game"||!root.current) {setPixels(large?320:256);return;}
    const update=(width:number)=>{
      const required=Math.max(1,width)*Math.min(window.devicePixelRatio||1,2);
      setPixels([192,256,320,384,512].find(size=>size>=required)??512);
    };
    return observeCoverSize(root.current,update);
  },[kind,large]);
  useEffect(()=>{
    if(!near) return;
    let active=true;
    const stopShell=kind==="game"?acquireCover({kind,src:"",scope:"neutral-shell",revision:"",pixels},value=>{if(active)setShell(value);}):()=>undefined;
    const stop=src?acquireCover({kind,src,scope,revision,pixels},value=>{if(active)setResult({key,value,failed:value===null});}):()=>undefined;
    return ()=>{active=false;stop();stopShell();setShell(null);setResult(null);};
  },[near,key,kind,src,scope,revision,pixels]);
  const visibleUrl=near?(current?.value?.url??(current?.failed?src:null)??shell?.url):null;
  return <span ref={root} className={`physical-cover physical-cover--${kind}`} data-ready={Boolean(visibleUrl)} data-source={current?.failed?"fallback":"rendered"}>
    <img src={visibleUrl??undefined} alt={alt} loading="lazy" decoding="async" draggable={false}
      onError={()=>{
        if(current?.failed) latestError.current?.();
        else setResult({key,value:null,failed:true});
      }} />
  </span>;
}
