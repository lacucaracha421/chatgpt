import {useEffect,useRef,useState,type RefObject} from 'react';
import {ArrowPathIcon} from '@heroicons/react/24/outline';
/** Only claim a downward, vertical, single-finger gesture that starts at the top. */
export function usePullToRefresh(host:RefObject<HTMLElement|null>,refresh:(()=>void)|undefined,busy:boolean,paused=false) {
  const [distance,setDistance]=useState(0);
  const current=useRef({refresh,busy,paused});current.current={refresh,busy,paused};
  useEffect(()=>{
    const element=host.current;if(!element)return;
    let start:{x:number;y:number}|null=null,dy=0;
    const reset=()=>{start=null;dy=0;setDistance(0);};
    const begin=(event:TouchEvent)=>{reset();if(!current.current.refresh||current.current.busy||current.current.paused||element.scrollTop>0||event.touches.length!==1)return;start={x:event.touches[0].clientX,y:event.touches[0].clientY};};
    const move=(event:TouchEvent)=>{
      if(!start)return;if(event.touches.length!==1||element.scrollTop>0){reset();return;}
      const touch=event.touches[0],y=touch.clientY-start.y,x=Math.abs(touch.clientX-start.x);
      if(y<0||x>Math.max(10,y)){reset();return;}
      if(y<8)return;
      if(event.cancelable)event.preventDefault();dy=Math.min(100,y*.5);setDistance(dy);
    };
    const end=()=>{const ready=dy>=60;reset();if(ready&&!current.current.busy&&!current.current.paused)current.current.refresh?.();};
    element.addEventListener('touchstart',begin,{passive:true});element.addEventListener('touchmove',move,{passive:false});element.addEventListener('touchend',end);element.addEventListener('touchcancel',reset);
    return()=>{element.removeEventListener('touchstart',begin);element.removeEventListener('touchmove',move);element.removeEventListener('touchend',end);element.removeEventListener('touchcancel',reset);};
  },[host]);
  return <div className={`pull-refresh ${busy?'busy':''}`} style={{height:refresh&&(busy||distance)?Math.max(44,distance):0}} role="status">{refresh&&(busy||distance>0)?<><ArrowPathIcon/><span>{busy?'새로고침 중':distance>=60?'놓으면 새로고침':'당겨서 새로고침'}</span></>:null}</div>;
}
