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
  const [tree,setTree]=useState<AlbumTree|null>(null),[error,setError]=useState('');
  useEffect(()=>{setTree(null);setError('');},[endpoint]);
  useEffect(()=>{
    if(!active)return;
    let controller:AbortController;
    const read=()=>{
      controller?.abort();controller=new AbortController();const signal=controller.signal;
      setError('');
      void native<AlbumTree>('albumTree',{},signal).then(value=>{
        if(!signal.aborted)setTree(value?.adopted&&Array.isArray(value.albums)?value:null);
      }).catch(reason=>{if(!signal.aborted)setError(errorText(reason));});
    };
    read();window.addEventListener('lakomics-resume',read);
    return()=>{controller.abort();window.removeEventListener('lakomics-resume',read);};
  },[active,revision,endpoint]);
  return {tree,error};
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
  const known=new Set(tree.albums.map(album=>album.id)),search=query.trim(),matches=createKoreanMatcher(search);
  const items=tree.albums.filter(album=>search?matches(album.name):parentId?album.parentId===parentId&&album.id!==parentId:!album.parentId||!known.has(album.parentId));
  const {covers,onVisible}=useAlbumCovers(tree,items,paused,revision);
  if(!tree.adopted||!tree.libraryId||tree.epoch===null)return null;
  return <div className={search?'library-results':parentId?'library-children':'library-folder-grid'}>{items.map(album=>search
    ? <AlbumResult key={album.id} album={album} path={albumAncestors(tree.albums,album.id).map(parent=>parent.name).join(' › ')||'최상위'} items={covers[album.id]??[]} paused={paused} onVisible={onVisible} onSelect={()=>onSelect(albumView(tree,album))}/>
    : <FolderCard key={album.id} id={album.id} name={album.name} count={album.assetCount} items={covers[album.id]??[]} paused={paused} childrenLabel={tree.albums.some(child=>child.parentId===album.id&&child.id!==album.id)?`하위 앨범 ${tree.albums.filter(child=>child.parentId===album.id&&child.id!==album.id).length}`:undefined} onVisible={onVisible} onSelect={()=>onSelect(albumView(tree,album))}/>
  )}{search&&!items.length&&<p className="hint">일치하는 앨범이 없습니다.</p>}</div>;
}
