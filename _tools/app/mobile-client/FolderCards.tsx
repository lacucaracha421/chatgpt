import {useEffect,useRef,useState} from 'react';
import {CoverGroup} from './CoverGroup';
import {api} from './transport';
import {mapBounded,normalizePage} from './model';
import type {Asset,Page,View} from './types';
import type {CharacterIndex} from './characterModel';
import {entryView,type Entry} from './libraryModel';
export function characterCovers(entry:Entry,index?:CharacterIndex):Asset[] {
  const node=index?.nodes.find(node=>node.id===entry.characterNode);
  return node?.thumbnailAssetId?[{id:node.thumbnailAssetId,kind:'image'}]:[];
}
export function FolderCard({id,name,count,items,paused,childrenLabel,onSelect,onVisible}:{id:string;name:string;count?:number;items:Asset[];paused:boolean;childrenLabel?:string;onSelect():void;onVisible(id:string,visible:boolean):void}) {
  const host=useRef<HTMLButtonElement>(null),[visible,setVisible]=useState(false);
  useEffect(()=>{
    if(!host.current)return;
    if(!window.IntersectionObserver){setVisible(true);onVisible(id,true);return;}
    const observer=new IntersectionObserver(records=>{const next=records.some(r=>r.isIntersecting);setVisible(next);onVisible(id,next);},{rootMargin:'120px'});
    observer.observe(host.current);return()=>observer.disconnect();
  },[id,onVisible]);
  return <button ref={host} className="library-folder" onClick={onSelect} aria-label={count===undefined?name:`${name}, ${count}개`}><CoverGroup items={items} paused={paused||!visible}/><span className="folder-caption"><strong>{name}</strong>{count!==undefined&&<span className="numeric muted">{count}</span>}</span>{childrenLabel&&<small>{childrenLabel}</small>}</button>;
}
export function FolderCards({items,entries,characters,paused,revision,onSelect,strip=false}:{items:Entry[];entries:Entry[];characters?:CharacterIndex;paused:boolean;revision:number;onSelect(view:View):void;strip?:boolean}) {
  const {covers,onVisible}=useFolderCovers(items,paused,revision);
  return <div className={strip?'library-children':'library-folder-grid'}>{items.map(entry=><FolderCard key={entry.id} id={entry.id} name={entry.name} count={entry.asset_count} items={entry.characterNode?characterCovers(entry,characters):covers[entry.id]??[]} paused={paused} childrenLabel={entries.some(item=>item.parent_id===entry.id)?`하위 폴더 ${entries.filter(item=>item.parent_id===entry.id).length}`:undefined} onSelect={()=>onSelect(entryView(entry))} onVisible={onVisible}/>)}</div>;
}
export function useFolderCovers(items:Entry[],paused:boolean,revision:number){
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
      try{const params=new URLSearchParams({classification_id:item.id,limit:'3'});const page=normalizePage(await api<Page>(`/v1/library/assets?${params}`,controller.signal));
        if(!controller.signal.aborted){completed.current.ids.add(item.id);setCovers(old=>({...old,[item.id]:page.items.slice(0,3)}));}
      }catch{/* A missing cover must not block navigation. */}
    },controller.signal).catch(()=>{});
    return()=>controller.abort();
  },[key,visibleKey,paused,revision]);
  return {covers,onVisible};
}
