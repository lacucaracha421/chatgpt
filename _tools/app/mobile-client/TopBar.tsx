import {ArrowLeftIcon,MagnifyingGlassIcon} from '@heroicons/react/24/outline';
import {useEffect,useRef,type ReactNode} from 'react';
import {IconButton,Mark} from './ui';
/**
 * The shared tab bar: the logo mark (or Back on a deeper level), the tab or place name, and the
 * actions that belong to that screen. Every tab uses the same 56px bar, so switching tabs never
 * moves the content.
 */
export function TopBar({title,count,crumbs,back,actions,className=''}:{title?:ReactNode;count?:ReactNode;crumbs?:ReactNode;back?:{label:string;onClick():void};actions?:ReactNode;className?:string}) {
  return <header className={`top-bar${className?` ${className}`:''}`}>
    {back?<IconButton label={back.label} icon={ArrowLeftIcon} onClick={back.onClick}/>:<span className="top-bar__brand"><Mark/></span>}
    <div className="top-bar__titles">{crumbs}{title!=null&&<div className="top-bar__title"><h1>{title}</h1>{count!=null&&count!==''&&<span className="numeric muted top-bar__count">{count}</span>}</div>}</div>
    <span className="top-bar__space"/>{actions}
  </header>;
}
/** Open search bars, so the system Back can close the visible one before navigating. */
const openSearches=new Set<{element:HTMLElement|null;close():void}>();
/** A retained tab is hidden with an inline `display:none`; its search does not count. */
const shown=(element:HTMLElement|null)=>!!element?.isConnected&&!element.closest('[style*="display: none"]');
/** Closes the visible open search, as Back does. Returns false when there is none. */
export function closeVisibleSearch() {
  for(const search of openSearches)if(shown(search.element)){search.close();return true;}
  return false;
}
/** A tap on something tappable (a result, a chip, a sheet) is left to that control. */
const INTERACTIVE='button,a,input,textarea,select,label,[role="option"],[role="listbox"],[role="dialog"]';
/**
 * Search replaces the bar's content while open; the field itself is supplied by the screen.
 * `onClose` (the ← button, Back, or a tap on empty space outside the bar) closes the bar and
 * clears the query, so no hidden query keeps narrowing the list.
 */
export function TopBarSearch({title,onClose,children}:{title:string;onClose():void;children:ReactNode}) {
  const bar=useRef<HTMLElement>(null);
  const close=useRef(onClose);close.current=onClose;
  useEffect(()=>{
    const entry={element:bar.current,close:()=>close.current()};
    openSearches.add(entry);
    const outside=(event:PointerEvent)=>{
      const target=event.target as Element|null;
      if(!target||!shown(bar.current)||bar.current?.contains(target)||target.closest(INTERACTIVE))return;
      close.current();
    };
    document.addEventListener('pointerdown',outside,true);
    return()=>{openSearches.delete(entry);document.removeEventListener('pointerdown',outside,true);};
  },[]);
  return <header ref={bar} className="top-bar is-search"><h1 className="sr-only">{title}</h1><IconButton label="검색 닫기" icon={ArrowLeftIcon} onClick={onClose}/>{children}</header>;
}
export function SearchButton({onClick}:{onClick():void}) {
  return <IconButton label="검색" icon={MagnifyingGlassIcon} onClick={onClick}/>;
}
