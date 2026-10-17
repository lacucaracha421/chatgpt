import {FindButton,type ScreenFind} from './FindContext';
import {MoreButton,MoreContext,MoreSheet,type ScreenMenu} from './MoreSheet';
import {ArrowLeftIcon,Bars3BottomLeftIcon,MagnifyingGlassIcon,PlusIcon} from '@heroicons/react/24/outline';
import {useContext,useEffect,useRef,useState,type ReactNode,type Ref} from 'react';
import {IconButton,Mark} from './ui';
import {useDelayedBusy} from '../src/shared/useDelayedBusy';
import {displayCount} from '../src/shared/displayDate';
/**
 * The shared tab bar: the logo mark (or Back on a deeper level), the tab or place name, and the
 * actions that belong to that screen. Every tab uses the same 56px bar, so switching tabs never
 * moves the content.
 */
/** One shared busy rule: 600 ms delay, 400 ms minimum, with no layout movement. */
export function LoadingLine({label,className=''}:{label:string|false|undefined;className?:string}) {
  const visible=useDelayedBusy(!!label);
  const named=useRef('');if(label)named.current=label;
  if(!visible)return null;
  return <span className={`loading-line is-timed${className?` ${className}`:''}`} role="status" aria-label={named.current}/>;
}
/**
 * The one place a page or scope load shows: a thin line on the bar's bottom edge. It is laid
 * over the bar's border, so appearing and disappearing never moves anything.
 */
export function BarProgress({label}:{label:string|false|undefined}) {
  return <LoadingLine label={label} className="top-bar__progress"/>;
}
export function TopBarActions({itemAction,search,menu,onMenu,menuCount=0}:{itemAction?:ReactNode;search?:ScreenFind;menu?:ScreenMenu;onMenu?():void;menuCount?:number}) {
  const more=useContext(MoreContext),[open,setOpen]=useState(false);
  return <><div className="top-bar__slots">{itemAction}<FindButton search={search}/><MoreButton count={menuCount||more?.options.reviewCount||0} onOpen={()=>{if(onMenu)onMenu();else if(more)more.open(menu);else setOpen(true);}}/></div>{open&&<MoreSheet screenTitle={menu?.title} screenEntries={menu?.entries} onClose={()=>setOpen(false)}/>}</>;
}
export function TopBar({title,titleAccessory,count,crumbs,back,drawer,itemAction,search,menu,onMenu,menuCount,className='',loading,barRef}:{title?:ReactNode;titleAccessory?:ReactNode;count?:ReactNode;crumbs?:ReactNode;back?:{label:string;onClick():void};/** The ☰ button of the folder drawer: after ← (or in the logo's place on the first screen). */drawer?:{onClick():void};itemAction?:ReactNode;search?:ScreenFind;menu?:ScreenMenu;onMenu?():void;menuCount?:number;className?:string;/** Accessible name of a running page/scope load; shows the bar's progress line. */loading?:string|false;/** The bar element, for a section shade's pull (SectionShade.tsx). */barRef?:Ref<HTMLElement>}) {
  return <header ref={barRef} className={`top-bar${className?` ${className}`:''}`}>
    {back?<IconButton label={back.label} icon={ArrowLeftIcon} onClick={back.onClick}/>:!drawer&&<span className="top-bar__brand"><Mark/></span>}
    {drawer&&<IconButton label="폴더 서랍" icon={Bars3BottomLeftIcon} onClick={drawer.onClick}/>}
    <div className="top-bar__titles">{crumbs&&<div className="top-bar__parent">{crumbs}</div>}{title!=null&&<div className="top-bar__title"><h1>{title}</h1>{titleAccessory}{count!=null&&count!==''&&<span className="numeric muted top-bar__count">{typeof count==='number'?displayCount(count):count}</span>}</div>}</div>
    <span className="top-bar__space"/><TopBarActions itemAction={itemAction} search={search} menu={menu} onMenu={onMenu} menuCount={menuCount}/><BarProgress label={loading}/>
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
export function TopBarSearch({title,onClose,children,loading,search,menu}:{title:string;onClose():void;children:ReactNode;loading?:string|false;search?:ScreenFind;menu?:ScreenMenu}) {
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
  return <header ref={bar} className="top-bar is-search"><h1 className="sr-only">{title}</h1><IconButton label="검색 닫기" icon={ArrowLeftIcon} onClick={onClose}/>{children}<TopBarActions search={search} menu={menu}/><BarProgress label={loading}/></header>;
}
export function SearchButton({onClick}:{onClick():void}) {
  return <IconButton label="검색" icon={MagnifyingGlassIcon} onClick={onClick}/>;
}
export function CreateWorkButton({onClick}:{onClick():void}) {
  return <IconButton label="새 작품" icon={PlusIcon} onClick={onClick}/>;
}
