import { useEffect, useRef, useState, type PointerEvent } from "react";
import { attachLiveBook, type LiveBook } from "./collectibleRuntime";
import "./physicalCollections.css";
export function PaperbackLive({src,alt,scope="",revision="",flat=false}:{src:string;alt:string;scope?:string;revision?:string;flat?:boolean}) {
  const host=useRef<HTMLDivElement>(null),live=useRef<LiveBook|null>(null),reduced=useRef(false);
  const key=JSON.stringify([src,scope,revision,flat]);
  const [state,setState]=useState({key:"",ready:false,failed:false});
  const ready=state.key===key&&state.ready,failed=state.key===key&&state.failed;
  useEffect(()=>{
    const query=window.matchMedia?.("(prefers-reduced-motion: reduce)");
    const update=()=>{reduced.current=query?.matches??false;if(reduced.current)live.current?.tilt(0,0);};
    update();query?.addEventListener("change",update);return ()=>query?.removeEventListener("change",update);
  },[]);
  useEffect(()=>{
    if(flat||!host.current) return;
    let active=true;
    const controller=attachLiveBook(host.current,{kind:"book",src,scope,revision,pixels:1024},value=>{if(active)setState({key,ready:value,failed:!value});});
    live.current=controller;
    return ()=>{active=false;controller.dispose();if(live.current===controller)live.current=null;};
  },[key,src,scope,revision,flat]);
  function tilt(event:PointerEvent<HTMLDivElement>) {
    if(flat||reduced.current||event.pointerType==="touch")return;
    const rect=event.currentTarget.getBoundingClientRect();
    live.current?.tilt(Math.max(-.5,Math.min(.5,(event.clientX-rect.left)/rect.width-.5)),Math.max(-.5,Math.min(.5,(event.clientY-rect.top)/rect.height-.5)));
  }
  return <div className="paperback-live" data-ready={ready} onPointerMove={tilt} onPointerLeave={()=>live.current?.tilt(0,0)}>
    <div ref={host} className="paperback-live__canvas" />
    {!ready&&<img className="paperback-live__original" src={src} alt={alt} decoding="async" draggable={false} />}
    {ready&&<span className="paperback-live__alt" role="img" aria-label={alt} />}
    {failed&&!flat&&<span className="paperback-live__notice" role="status">입체 표현 대신 원본 표지를 표시합니다.</span>}
  </div>;
}
