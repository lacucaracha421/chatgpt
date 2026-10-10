import {useTabletAssetMask} from './assetMask';
import {useNsfwFilter} from './privacyMode';
import {collectionCover} from './collectionModel';
import * as RadixDialog from '@radix-ui/react-dialog';
import {useDeferredValue,useEffect,useId,useLayoutEffect,useMemo,useRef,useState} from 'react';
import {XMarkIcon,MagnifyingGlassIcon,PhotoIcon} from '@heroicons/react/24/outline';
import {useDelayedBusy} from '../src/shared/useDelayedBusy';
import {Button,EmptyState,IconButton,TextInput,SectionLabel,Skeleton} from './ui';
import {FindEntryContent} from '../src/shared/FindEntryContent';
import {findGroups,GROUP_LIMIT,readRecent,rememberRecent,type FindScope} from '../src/shared/findModel';
import {NAVIGATION_GROUP_LABELS,type NavigationEntryGroup} from '../src/shared/findEntries';
import {TABLET_FIND_SCOPES,useDescriptionStrip,type TabletFindEntry} from './findData';
import {DescriptionStrip} from './FindDescriptionStrip';
import {DESCRIPTION_PREVIEW_COUNT,descriptionQueryReady} from './descriptionSearch';
import {artworkTicket,decoded} from './collectionArtwork';
import {decodeImage,mediaTicket} from './media';
import {useNoteEditor} from './noteCaret';
import './find.css';

type CachedMedia={url:string;promise:Promise<string>};
type MediaCache=Map<string,CachedMedia>;
/** Only displayed rows request media; typing reuses the open session's decoded thumbnails. */
function FindMedia({entry,cache,signal}:{entry:TabletFindEntry;cache:MediaCache;signal:AbortSignal}) {
  const masked=useTabletAssetMask({contentRating:entry.contentRating}) && Boolean(entry.assetId) && !entry.work;
  const [url,setUrl]=useState(()=>cache.get(entry.id)?.url??'');
  useEffect(()=>{
    if(masked)return;
    if((!entry.work&&!entry.assetId)||(entry.work&&!collectionCover(entry.work.item)&&!entry.work.item.coverAssetId))return;
    let active=true;
    if(!cache.has(entry.id)){
      const request=entry.work?artworkTicket(entry.work.item,collectionCover(entry.work.item),entry.work.revision,false,signal):mediaTicket({id:entry.assetId!,kind:'image',contentRating:entry.contentRating},'thumbnail',signal);
      const cached:CachedMedia={url:'',promise:request.then(async ticket=>{if(signal.aborted)return '';if(entry.work)await decoded(ticket.url);else await decodeImage(ticket.url,signal);cached.url=ticket.url;return ticket.url;}).catch(()=>'')};
      cache.set(entry.id,cached);
    }
    void cache.get(entry.id)!.promise.then(value=>{if(active&&!signal.aborted)setUrl(value);});
    return()=>{active=false;};
  },[entry.id,cache,signal,masked]);
  return masked?<span className="privacy-mask" aria-label="이미지 숨김"/>:url?<img src={url} alt="" className={entry.avatar?'find-entry__avatar':undefined}/>:entry.icon;
}

export function FindSheet({open,onClose,entries,endpoint,privacy,loading=false,error,onRetry,onDescription}:{open:boolean;onClose():void;entries:TabletFindEntry[];endpoint:string;privacy:boolean;loading?:boolean;error?:string;onRetry?():void;/** Opens the 내용 검색 result state; absent when the screen cannot show one. */onDescription?(query:string):void}) {
  const [nsfwFilter]=useNsfwFilter();
  const [query,setQuery]=useState(''),[scope,setScope]=useState<FindScope>('전체');
  const [expanded,setExpanded]=useState<NavigationEntryGroup[]>([]),[recent,setRecent]=useState<string[]>([]),[activeId,setActiveId]=useState<string|null>(null);
  const field=useRef<HTMLInputElement|null>(null),editor=useNoteEditor();
  const picked=useRef(false),opener=useRef<HTMLElement|null>(null);
  const id=useId(),recentKey=`tablet:${endpoint}`;
  const session=useMemo(()=>({cache:new Map() as MediaCache,controller:new AbortController()}),[open,endpoint,privacy,nsfwFilter]);
  useEffect(()=>()=>session.controller.abort(),[session]);
  useLayoutEffect(()=>{
    if(!open)return;
    picked.current=false;opener.current=document.activeElement instanceof HTMLElement?document.activeElement:null;
    setQuery('');setScope('전체');setExpanded([]);setActiveId(null);setRecent(privacy?[]:readRecent(recentKey));
  },[open,recentKey]);
  useEffect(()=>{if(open&&!privacy)setRecent(readRecent(recentKey));},[privacy,open,recentKey]);
  const draft=useDeferredValue(useMemo(()=>({query,scope}),[query,scope]));
  const strip=useDescriptionStrip({open,endpoint,query:draft.query,enabled:!!onDescription&&draft.scope==='전체',count:DESCRIPTION_PREVIEW_COUNT});
  const stripBusy=useDelayedBusy(strip.busy);
  const typed=draft.query.trim(),notReady=strip.shown?.ready===false;
  const withContent=useMemo(()=>onDescription&&draft.scope==='전체'&&descriptionQueryReady(typed)?[{id:'description-search',group:'content',label:`‘${typed}’ 장면 찾기`,icon:<PhotoIcon/>,activity:stripBusy?'장면을 찾는 중…':notReady?undefined:'Enter',
    detail:<DescriptionStrip answer={strip.shown} failed={strip.failed} cache={session.cache} signal={session.controller.signal} privacy={privacy}/>,
    destination:{kind:'screen',screen:'assets'},run:()=>onDescription(typed)} as TabletFindEntry,...entries]:entries,[onDescription,draft.scope,typed,stripBusy,notReady,strip.shown,strip.failed,session,privacy,entries]);
  const groups=useMemo(()=>{
    const found=findGroups(withContent,draft.query,draft.scope,privacy?[]:recent);
    // Until the captions exist the row is informational, so Enter keeps going to the first real match.
    return notReady?[...found.filter(({group})=>group!=='content'),...found.filter(({group})=>group==='content')]:found;
  },[withContent,draft,privacy,recent,notReady]);
  const displayed=groups.map(({group,items})=>({group,items:expanded.includes(group)?items:items.slice(0,GROUP_LIMIT),total:items.length}));
  const ordered=displayed.flatMap(group=>group.items) as TabletFindEntry[];
  const selected=ordered.findIndex(entry=>entry.id===activeId);const current=Math.max(0,selected);
  const pick=(entry:TabletFindEntry)=>{
    if(!privacy&&entry.group!=='content')setRecent(rememberRecent(recentKey,entry.id));
    picked.current=true;onClose();entry.run();
  };
  useEffect(()=>{if(open)document.getElementById(`${id}-option-${current}`)?.scrollIntoView?.({block:'nearest'});},[open,current,id]);
  const stale=query!==draft.query||scope!==draft.scope;
  return <RadixDialog.Root open={open} onOpenChange={next=>{if(!next)onClose();}}>
    <RadixDialog.Portal>
      <RadixDialog.Overlay className="tablet-find-overlay"/>
      <RadixDialog.Content className="tablet-find" aria-describedby={undefined} onOpenAutoFocus={event=>{event.preventDefault();field.current?.focus();}} onCloseAutoFocus={event=>{event.preventDefault();if(!picked.current&&opener.current?.isConnected)opener.current.focus();}}
        onEscapeKeyDown={event=>{event.preventDefault();if(!event.isComposing&&event.keyCode!==229&&!(field.current&&editor.isComposing(field.current)))onClose();}}>
        <header className="tablet-find__bar"><RadixDialog.Title>찾기</RadixDialog.Title><IconButton label="찾기 닫기" icon={XMarkIcon} onClick={onClose}/></header>
        <div className="tablet-find__field"><TextInput icon={MagnifyingGlassIcon} {...editor.bind(query,value=>{setQuery(value);setExpanded([]);setActiveId(null);},field)} autoFocus role="combobox" aria-label="작품, 작가, 메모 제목, 폴더, 화면 이름" aria-expanded="true" aria-controls={`${id}-results`} aria-activedescendant={ordered.length?`${id}-option-${current}`:undefined} aria-autocomplete="list" placeholder="작품, 작가, 메모, 폴더 찾기" autoComplete="off" spellCheck={false} enterKeyHint="go"
          onKeyDown={event=>{
            if(editor.isComposing(event.currentTarget)||event.nativeEvent.isComposing||event.nativeEvent.keyCode===229)return;
            if(event.key==='ArrowDown'||event.key==='ArrowUp'){
              event.preventDefault();if(ordered.length)setActiveId(ordered[(current+(event.key==='ArrowDown'?1:ordered.length-1))%ordered.length].id);
            }else if(event.key==='Enter'){event.preventDefault();if(!stale&&ordered[current])pick(ordered[current]);}
          }}/></div>
        <div className="tablet-find__scopes" role="group" aria-label="찾기 범위">{TABLET_FIND_SCOPES.map(name=><Button type="button" key={name} variant="ghost" aria-pressed={scope===name} onPointerDown={event=>event.preventDefault()} onClick={()=>{setScope(name);setExpanded([]);setActiveId(null);}}>{name}</Button>)}</div>
        <div className="tablet-find__results" id={`${id}-results`} role="listbox" aria-label="찾기 결과" aria-busy={loading||stale} inert={stale||undefined}>
          {!ordered.length&&(loading?<div className="tablet-find__skeleton"><Skeleton/><Skeleton/><Skeleton/></div>:<EmptyState inline className="tablet-find__empty" title={query.trim()?'검색 결과 없음':privacy?'이름으로 찾기':'최근 연 항목이 없습니다.'} />)}
          {displayed.map(({group,items,total})=><div key={group} role="group" aria-labelledby={`${id}-${group}`}>
            <SectionLabel as="h2" id={`${id}-${group}`} title={NAVIGATION_GROUP_LABELS[group]}/>
            {items.map(entry=>{const index=ordered.findIndex(item=>item.id===entry.id);return <div key={entry.id} id={`${id}-option-${index}`} role="option" tabIndex={0} aria-selected={index===current} className="tablet-find__option" onPointerDown={event=>event.preventDefault()} onClick={()=>pick(entry as TabletFindEntry)} onKeyDown={event=>{if(event.key==='Enter'||event.key===' '){event.preventDefault();pick(entry as TabletFindEntry);}}}>
              <FindEntryContent entry={entry} query={draft.query} privacy={privacy} media={!privacy?<FindMedia entry={entry as TabletFindEntry} cache={session.cache} signal={session.controller.signal}/>:undefined}/>
            </div>;})}
            {total>GROUP_LIMIT&&<Button className="tablet-find__more" type="button" variant="ghost" onPointerDown={event=>event.preventDefault()} onClick={()=>setExpanded(previous=>previous.includes(group)?previous.filter(value=>value!==group):[...previous,group])}>{expanded.includes(group)?'접기':`${NAVIGATION_GROUP_LABELS[group]} ${total-GROUP_LIMIT}개 더 보기`}</Button>}
          </div>)}
        </div>
        {error&&<div className="tablet-find__error" role="status"><span>{error}</span>{onRetry&&<Button variant="ghost" onClick={onRetry}>다시 시도</Button>}</div>}
      </RadixDialog.Content>
    </RadixDialog.Portal>
  </RadixDialog.Root>;
}
