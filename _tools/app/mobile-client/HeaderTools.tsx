import {useEffect,useState,type ReactNode} from 'react';
import {createPortal} from 'react-dom';
export function HeaderTools({active,children,target='context-tools',landscapeOnly=false}:{active:boolean;children:ReactNode;target?:'context-tools'|'context-location';landscapeOnly?:boolean}) {
  const [host,setHost]=useState<HTMLElement|null>(null);
  const [landscape,setLandscape]=useState(()=>window.matchMedia?.('(orientation: landscape) and (min-width: 900px)').matches??false);
  useEffect(()=>{setHost(document.getElementById(target));},[target]);
  useEffect(()=>{if(!landscapeOnly)return;const media=window.matchMedia?.('(orientation: landscape) and (min-width: 900px)');if(!media)return;const update=()=>setLandscape(media.matches);update();media.addEventListener('change',update);return()=>media.removeEventListener('change',update);},[landscapeOnly]);
  return active?(host&&(!landscapeOnly||landscape)?createPortal(children,host):children):null;
}
