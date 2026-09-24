import {useEffect,useRef,useState,type RefObject} from 'react';
import {ArrowPathIcon} from '@heroicons/react/24/outline';
/**
 * Only claim a downward, vertical, single-finger gesture that starts at the top.
 *
 * The indicator is a zero-height sticky anchor with a floating pill, so pulling, releasing and
 * the refresh that follows never push the content down. The pill reports "새로고침 중" only for
 * a refresh this gesture started; other loads (opening a folder, a background re-read) keep the
 * previous content in place and use the screen's thin progress line instead.
 */
export function usePullToRefresh(host:RefObject<HTMLElement|null>,refresh:(()=>void)|undefined,busy:boolean,paused=false) {
  const [distance,setDistance]=useState(0);
  const [pulled,setPulled]=useState(false);
  const current=useRef({refresh,busy,paused});current.current={refresh,busy,paused};
  // A pull-started refresh stays announced until the load it started settles.
  const sawBusy=useRef(false);
  useEffect(()=>{
    if(!pulled)return;
    if(busy){sawBusy.current=true;return;}
    // The refresh may commit before `busy` is ever observed; give it one frame to begin.
    if(sawBusy.current){sawBusy.current=false;setPulled(false);return;}
    const timer=window.setTimeout(()=>setPulled(false),400);
    return()=>clearTimeout(timer);
  },[busy,pulled]);
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
    const end=()=>{const ready=dy>=60;reset();if(ready&&!current.current.busy&&!current.current.paused&&current.current.refresh){sawBusy.current=false;setPulled(true);current.current.refresh();}};
    element.addEventListener('touchstart',begin,{passive:true});element.addEventListener('touchmove',move,{passive:false});element.addEventListener('touchend',end);element.addEventListener('touchcancel',reset);
    return()=>{element.removeEventListener('touchstart',begin);element.removeEventListener('touchmove',move);element.removeEventListener('touchend',end);element.removeEventListener('touchcancel',reset);};
  },[host]);
  const refreshing=pulled&&!!refresh;
  const shown=!!refresh&&(refreshing||distance>0);
  // The pill follows the finger while pulling and rests just below the top edge while refreshing.
  const offset=refreshing&&!distance?56:Math.max(0,distance);
  return <div className="pull-refresh" role="status">
    {shown&&<span className={`pull-refresh__pill${refreshing?' is-refreshing':''}${distance>=60?' is-ready':''}`} style={{transform:`translate(-50%,${offset-44}px)`,opacity:refreshing?1:Math.min(1,distance/60)}}>
      <ArrowPathIcon aria-hidden="true" style={refreshing?undefined:{transform:`rotate(${distance*3}deg)`}}/><span>{refreshing?'새로고침 중':distance>=60?'놓으면 새로고침':'당겨서 새로고침'}</span>
    </span>}
  </div>;
}
