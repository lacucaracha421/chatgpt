import {Button,EmptyState} from './ui';
import {AlbumManagement} from './AlbumManagement';
import {ALBUM_TREE_CHANGED,readAlbumSnapshot} from './albumCommands';
import {ClassificationIcon,classificationColor} from '../src/classification/classificationAppearance';
import {useFirstAppearance} from '../src/shared/motion/useFirstAppearance';
import {useHorizontalWheel} from '../src/shared/ui/useHorizontalWheel';
import {useEffect,useRef,useState} from 'react';
import {ChevronRightIcon} from '@heroicons/react/24/outline';
import {api,errorText,native} from './transport';
import {mapBounded,pagePath} from './model';
import {CoverGroup} from './CoverGroup';
import {FolderCard} from './FolderCards';
import {albumAncestors,albumPage,albumView,type AlbumAssetPage,type AlbumTree,type NativeAlbum} from './albumModel';
import type {Asset,View} from './types';
import {createKoreanMatcher} from '../src/shared/koreanSearch';
export {albumPath} from './albumModel';
export type {AlbumTree,NativeAlbum} from './albumModel';

/** Keep the native replica available while drilling down; every resume replaces older reads. */
export function useAlbumTree(active:boolean,revision:number,endpoint:string) {
  const [tree,setTree]=useState<AlbumTree|null>(null),[error,setError]=useState(''),[loading,setLoading]=useState(false);
  const edited=useRef(false),generation=useRef(0);
  useEffect(()=>{edited.current=false;generation.current++;setTree(null);setError('');},[endpoint]);
  useEffect(()=>{
    const changed=(event:Event)=>{const next=(event as CustomEvent<AlbumTree>).detail;edited.current=true;generation.current++;setLoading(false);setTree(current=>current?.libraryId===next.libraryId&&current.epoch===next.epoch?next:current);};
    window.addEventListener(ALBUM_TREE_CHANGED,changed);
    return()=>window.removeEventListener(ALBUM_TREE_CHANGED,changed);
  },[endpoint]);
  useEffect(()=>{
    if(!active)return;
    let controller:AbortController;
    const read=()=>{
      controller?.abort();controller=new AbortController();const signal=controller.signal;
      const current=++generation.current;
      setError('');setLoading(true);
      void native<AlbumTree>('albumTree',{},signal).then(async value=>{
        if(edited.current&&value?.adopted){
          const snapshot=await readAlbumSnapshot(value,signal);
          value={...value,albums:snapshot.albums.map(album=>({...value.albums.find(item=>item.id===album.id),...album}))};
        }
        if(!signal.aborted&&current===generation.current)setTree(value?.adopted&&Array.isArray(value.albums)?value:null);
      }).catch(reason=>{if(!signal.aborted&&current===generation.current)setError(errorText(reason));}).finally(()=>{if(!signal.aborted&&current===generation.current)setLoading(false);});
    };
    read();window.addEventListener('lakomics-resume',read);
    return()=>{controller.abort();window.removeEventListener('lakomics-resume',read);};
  },[active,revision,endpoint]);
  return {tree,error,loading};
}
function useAlbumCovers(tree:AlbumTree,items:NativeAlbum[],paused:boolean,revision:number) {
  const [visible,setVisible]=useState<Set<string>>(new Set()),[covers,setCovers]=useState<Record<string,Asset[]>>({});
  const completed=useRef({key:'',ids:new Set<string>()});
  const onVisible=useRef((id:string,show:boolean)=>setVisible(old=>{if(old.has(id)===show)return old;const next=new Set(old);if(show)next.add(id);else next.delete(id);return next;})).current;
  const key=JSON.stringify([tree.libraryId,tree.epoch,revision,items.map(item=>item.id)]),visibleKey=JSON.stringify([...visible].sort());
  useEffect(()=>{
    if(paused||!tree.adopted||!tree.libraryId||tree.epoch===null)return;
    if(completed.current.key!==key)completed.current={key,ids:new Set()};
    const controller=new AbortController();
    void mapBounded(items.filter(item=>visible.has(item.id)&&!completed.current.ids.has(item.id)),2,async album=>{
      try {
        const path=pagePath(albumView(tree,album),null,undefined,3);
        const page=albumPage(await api<AlbumAssetPage>(path,controller.signal));
        if(!controller.signal.aborted){completed.current.ids.add(album.id);setCovers(old=>({...old,[album.id]:page.items.slice(0,3)}));}
      }catch{/* Covers are optional; the scope load reports actionable errors. */}
    },controller.signal).catch(()=>{});
    return()=>controller.abort();
  },[key,visibleKey,paused]);
  return {covers,onVisible};
}
function AlbumResult({album,path,items,paused,onVisible,onSelect}:{album:NativeAlbum;path:string;items:Asset[];paused:boolean;onVisible(id:string,visible:boolean):void;onSelect():void}) {
  const host=useRef<HTMLButtonElement>(null),[visible,setVisible]=useState(false);
  useEffect(()=>{
    if(!host.current)return;
    if(!window.IntersectionObserver){setVisible(true);onVisible(album.id,true);return;}
    const observer=new IntersectionObserver(records=>{const next=records.some(r=>r.isIntersecting);setVisible(next);onVisible(album.id,next);},{rootMargin:'120px'});
    observer.observe(host.current);return()=>observer.disconnect();
  },[album.id,onVisible]);
  return <button ref={host} className="library-result" aria-label={`${album.name}, ${path}`} onClick={onSelect}><span className="album-result-cover"><CoverGroup items={items.slice(0,1)} paused={paused||!visible}/></span><span className="result-name"><strong>{album.name}</strong><small>{path}</small></span>{album.assetCount!==undefined&&<span className="numeric muted">{album.assetCount}</span>}<ChevronRightIcon/></button>;
}
export function Albums({tree,paused,revision,onSelect,query='',parentId}:{tree:AlbumTree;paused:boolean;revision:number;onSelect(view:View):void;query?:string;parentId?:string}) {
  const [manage,setManage]=useState<NativeAlbum|'create'|null>(null);
  const stripWheel=useHorizontalWheel();
  const known=new Set(tree.albums.map(album=>album.id)),search=query.trim(),matches=createKoreanMatcher(search);
  const items=tree.albums.filter(album=>search?matches(album.name):parentId?album.parentId===parentId&&album.id!==parentId:!album.parentId||!known.has(album.parentId));
  const host=useRef<HTMLDivElement>(null);
  useFirstAppearance(host,items.length,!paused&&!search&&tree.adopted,"classification-albums",".library-folder");
  const {covers,onVisible}=useAlbumCovers(tree,items,paused,revision);
  if(!tree.adopted||!tree.libraryId||tree.epoch===null)return null;
  return <>{!search&&!parentId&&<Button className="album-management-create" onClick={()=>setManage('create')}>새 앨범</Button>}<div ref={element=>{host.current=element;return stripWheel(parentId&&!search?element:null);}} className={search?'library-results':parentId?'library-children':'library-folder-grid'}>{items.map(album=>search
    ? <AlbumResult key={album.id} album={album} path={albumAncestors(tree.albums,album.id).map(parent=>parent.name).join(' › ')||'최상위'} items={covers[album.id]??[]} paused={paused} onVisible={onVisible} onSelect={()=>onSelect(albumView(tree,album))}/>
    : <div key={album.id} className="album-card-management"><FolderCard id={album.id} name={album.name} count={album.assetCount} items={covers[album.id]??[]} paused={paused} childrenLabel={tree.albums.some(child=>child.parentId===album.id&&child.id!==album.id)?`하위 앨범 ${tree.albums.filter(child=>child.parentId===album.id&&child.id!==album.id).length}`:undefined} onVisible={onVisible} onSelect={()=>onSelect(albumView(tree,album))}/><Button size="icon" variant="ghost" aria-label={`${album.name} 앨범 관리`} onClick={()=>setManage(album)}><ClassificationIcon kind="root" iconKey={album.iconKey} style={{color:classificationColor(album.colorKey)}}/></Button></div>
  )}{search&&!items.length&&<EmptyState inline title="검색 결과 없음" />}</div>{manage&&<AlbumManagement tree={tree} album={manage==='create'?undefined:manage} parentId={parentId} onClose={()=>setManage(null)}/>}</>;
}
