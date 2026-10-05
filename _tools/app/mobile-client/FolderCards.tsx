import './folderCounts.css';
import {Fold} from './Fold';
import {useFirstAppearance} from '../src/shared/motion/useFirstAppearance';
import {useEffect,useRef,useState,type ReactNode} from 'react';
import {CoverGroup} from './CoverGroup';
import {api} from './transport';
import {mapBounded,normalizePage} from './model';
import type {Asset,Page,View} from './types';
import type {CharacterIndex} from './characterModel';
import {entryView,type Entry} from './libraryModel';
import {CountBadge,SectionLabel} from './ui';
import {ShelfScroller} from '../src/shared/ui/ShelfScroller';
import {FolderIcon,UserGroupIcon,UserIcon} from '@heroicons/react/24/outline';
export type CharacterFolderKind='series'|'group'|'character';
/** The character kind of a Library entry, or undefined for an ordinary asset folder. */
export const characterKindOf=(entry:Entry):CharacterFolderKind|undefined=>entry.characterNode?characterFolderKind(entry.characterKind??'series'):undefined;
/** A plain folder node inside a series stays an ordinary folder. */
export const characterFolderKind=(kind:string|undefined):CharacterFolderKind|undefined=>kind==='series'||kind==='group'||kind==='character'?kind:undefined;
/**
 * The PC's squared person/people glyphs, marking character folders apart from asset folders:
 * a series or group shows people, a single character a person.
 */
export function CharacterGlyph({kind}:{kind:CharacterFolderKind}) {
  const Icon=kind==='character'?UserIcon:UserGroupIcon;
  return <Icon className="character-glyph" aria-hidden="true"/>;
}
const KIND_NAMES:Record<CharacterFolderKind,string>={series:'캐릭터 시리즈',group:'캐릭터 그룹',character:'캐릭터'};

/**
 * Tablet counterpart of the PC FolderShelf. The PC component also owns an anchored panel and
 * therefore cannot be mounted here without the desktop BackNavigation provider. ShelfScroller is
 * presentation-only, so it keeps the same wheel, drag and clipped-last-card behaviour on both
 * clients.
 */
export function FolderShelf({label,cards,accessory,ariaLabel,className,cardsId,cardsHidden,hidden=false,appearanceKey,appearanceEnabled=true,appearancePlace,appearanceSelector='.folder-shelf__card'}:{label:string;cards:ReactNode[];accessory?:ReactNode;ariaLabel?:string;className?:string;cardsId?:string;cardsHidden?:boolean;hidden?:boolean;appearanceKey?:string;appearanceEnabled?:boolean;
  /** The place whose cards are shown: a new place's first cards enter like the first visit's (the PC shelf's first batch). */appearancePlace?:string;appearanceSelector?:string}) {
  const host=useRef<HTMLElement>(null);
  useFirstAppearance(host,cards.length,!!appearanceKey&&appearanceEnabled&&!cardsHidden&&!hidden,appearanceKey,appearanceSelector,appearancePlace);
  return <section ref={host} style={{display:hidden?'none':undefined}} inert={hidden||undefined} aria-hidden={hidden||undefined} className={['folder-shelf',className].filter(Boolean).join(' ')} aria-label={ariaLabel??label}>
    <SectionLabel as="h3" className="folder-shelf__label" title={label} actions={accessory}/>
    {cards.length>0&&<Fold keepMounted open={!cardsHidden} id={cardsId}><ShelfScroller previousLabel="이전 항목" nextLabel="다음 항목">{cards}</ShelfScroller></Fold>}
  </section>;
}

function ShelfFolderCard({entry,items,characters,paused,onSelect,onVisible}:{entry:Entry;items:Asset[];characters?:CharacterIndex;paused:boolean;onSelect():void;onVisible(id:string,visible:boolean):void}) {
  const host=useRef<HTMLElement>(null),[visible,setVisible]=useState(false);
  useEffect(()=>{
    if(!host.current)return;
    if(!window.IntersectionObserver){setVisible(true);onVisible(entry.id,true);return;}
    const observer=new IntersectionObserver(records=>{const next=records.some(record=>record.isIntersecting);setVisible(next);onVisible(entry.id,next);},{rootMargin:'120px'});
    observer.observe(host.current);return()=>observer.disconnect();
  },[entry.id,onVisible]);
  const kind=characterKindOf(entry);
  const count=entry.asset_count;
  return <article className="folder-shelf__card" ref={host}>
    <button type="button" className="folder-shelf__card-open" onClick={onSelect} aria-label={`${entry.name}${count===undefined?'':`, ${count}장`}`}>
      <span className="folder-thumbnail"><CoverGroup items={kind?characterCovers(entry,characters):items} paused={paused||!visible}/>{count!==undefined&&<CountBadge variant="scrim" className="folder-thumbnail__count" value={count} unit="장"/>}</span>
      <strong><span className="folder-shelf__icon">{kind?<CharacterGlyph kind={kind}/>:<FolderIcon aria-hidden="true"/>}</span><span className="folder-shelf__name">{entry.name}</span></strong>
    </button>
  </article>;
}

export function characterCovers(entry:Entry,index?:CharacterIndex):Asset[] {
  const node=index?.nodes.find(node=>node.id===entry.characterNode);
  return node?.thumbnailAssetId?[{id:node.thumbnailAssetId,kind:'image',contentRating:index?.contentRatings?.[node.thumbnailAssetId]??null}]:[];
}
export function FolderCard({id,name,count,items,paused,childrenLabel,kind,onSelect,onVisible}:{id:string;name:string;count?:number;items:Asset[];paused:boolean;childrenLabel?:string;/** Marks a character folder (glyph and card tint); absent for an asset folder. */kind?:CharacterFolderKind;onSelect():void;onVisible(id:string,visible:boolean):void}) {
  const host=useRef<HTMLButtonElement>(null),[visible,setVisible]=useState(false);
  useEffect(()=>{
    if(!host.current)return;
    if(!window.IntersectionObserver){setVisible(true);onVisible(id,true);return;}
    const observer=new IntersectionObserver(records=>{const next=records.some(r=>r.isIntersecting);setVisible(next);onVisible(id,next);},{rootMargin:'120px'});
    observer.observe(host.current);return()=>observer.disconnect();
  },[id,onVisible]);
  return <button ref={host} className={`library-folder${kind?' is-character':''}`} onClick={onSelect} aria-label={count===undefined?name:`${name}, ${count}개`} aria-description={kind?KIND_NAMES[kind]:undefined}><span className="folder-thumbnail"><CoverGroup items={items} paused={paused||!visible}/>{count!==undefined&&<CountBadge variant="scrim" className="folder-thumbnail__count" value={count}/>}</span><span className="folder-caption">{kind&&<CharacterGlyph kind={kind}/>}<strong>{name}</strong></span>{childrenLabel&&<small>{childrenLabel}</small>}</button>;
}
export function FolderCards({items,entries,characters,paused,revision,onSelect,strip=false,place}:{items:Entry[];entries:Entry[];characters?:CharacterIndex;paused:boolean;revision:number;onSelect(view:View):void;strip?:boolean;/** The folder these cards belong to; moving to another folder replays their first batch. */place?:string}) {
  const host=useRef<HTMLDivElement>(null);
  useFirstAppearance(host,items.length,!paused,"classification-folders",".library-folder",place);
  const {covers,onVisible}=useFolderCovers(items,paused,revision,entries);
  if(strip)return <FolderShelf appearanceKey="classification-folder-shelf" appearanceEnabled={!paused} appearancePlace={place} label={`폴더 ${items.length}`} cards={items.map(entry=><ShelfFolderCard key={entry.id} entry={entry} items={covers[entry.id]??[]} characters={characters} paused={paused} onSelect={()=>onSelect(entryView(entry))} onVisible={onVisible}/>)} />;
  return <div ref={host} className={strip?'library-children':'library-folder-grid'}>{items.map(entry=><FolderCard key={entry.id} id={entry.id} name={entry.name} kind={characterKindOf(entry)} count={entry.asset_count} items={entry.characterNode?characterCovers(entry,characters):covers[entry.id]??[]} paused={paused} childrenLabel={entries.some(item=>item.parent_id===entry.id)?`하위 폴더 ${entries.filter(item=>item.parent_id===entry.id).length}`:undefined} onSelect={()=>onSelect(entryView(entry))} onVisible={onVisible}/>)}</div>;
}
const coverDate=(asset:Asset)=>asset.collected_at??asset.created_at??'';
/** Plain subfolders under `id`, nearest first, that hold assets: covers for a folder with few direct assets. */
function coverDescendants(entries:Entry[],id:string,limit=6):Entry[]{
  const found:Entry[]=[];let level=[id];
  while(level.length&&found.length<limit){
    const next=entries.filter(item=>!item.characterNode&&item.parent_id!=null&&level.includes(item.parent_id));
    found.push(...next.filter(item=>item.asset_count>0));level=next.map(item=>item.id);
  }
  return found.slice(0,limit);
}
async function folderCoverPage(id:string,signal:AbortSignal):Promise<Asset[]>{
  const params=new URLSearchParams({classification_id:id,limit:'3'});
  return normalizePage(await api<Page>(`/v1/library/assets?${params}`,signal)).items.slice(0,3);
}
export function useFolderCovers(items:Entry[],paused:boolean,revision:number,entries:Entry[]=[]){
  const [visible,setVisible]=useState<Set<string>>(new Set()),[covers,setCovers]=useState<Record<string,Asset[]>>({});
  const completed=useRef({key:'',ids:new Set<string>()});
  const onVisible=useRef((id:string,show:boolean)=>setVisible(old=>{if(old.has(id)===show)return old;const next=new Set(old);if(show)next.add(id);else next.delete(id);return next;})).current;
  const key=JSON.stringify([revision,items.map(item=>item.id)]),visibleKey=[...visible].sort().join(',');
  useEffect(()=>{
    if(paused||!revision)return;
    if(completed.current.key!==key)completed.current={key,ids:new Set()};
    const pending=items.filter(item=>visible.has(item.id)&&!item.characterNode&&!completed.current.ids.has(item.id));
    const controller=new AbortController();
    void mapBounded(pending,2,async item=>{
      try{let found=await folderCoverPage(item.id,controller.signal);
        // A folder that keeps its assets in subfolders (e.g. 기타) borrows their newest ones.
        if(found.length<3){
          const more=await mapBounded(coverDescendants(entries,item.id),2,child=>folderCoverPage(child.id,controller.signal).catch(()=>[] as Asset[]),controller.signal);
          const seen=new Set(found.map(asset=>asset.id));
          found=[...found,...more.flat().filter(asset=>!seen.has(asset.id)&&seen.add(asset.id)).sort((a,b)=>coverDate(b).localeCompare(coverDate(a)))].slice(0,3);
        }
        if(!controller.signal.aborted){completed.current.ids.add(item.id);setCovers(old=>({...old,[item.id]:found}));}
      }catch{/* A missing cover must not block navigation. */}
    },controller.signal).catch(()=>{});
    return()=>controller.abort();
  },[key,visibleKey,paused,revision]);
  return {covers,onVisible};
}
