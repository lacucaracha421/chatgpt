import {useCallback,useEffect,useRef,useState} from 'react';
import {api,errorText,native} from './transport';
import {ASSET_LIST_CHANGED_EVENT} from './listGeneration';
import type {AlbumTree} from './albumModel';

type Member = {assetId:string;desiredState:boolean;entityRevision:number};
type LikesState = {albumId:string|null;memberships:Member[]};
type Identity = {libraryId:string;epoch:number};
const likesPath=(identity:Identity,ids:string[])=>`/v1/albums/likes?libraryId=${encodeURIComponent(identity.libraryId)}&epoch=${identity.epoch}&assetIds=${ids.map(encodeURIComponent).join(',')}`;

/** Read the authority membership, including revisions; old favorite flags have no meaning here. */
export function useLikesAlbum(ids:string[],enabled:boolean,revision:unknown) {
  const [liked,setLiked]=useState<ReadonlySet<string>>(new Set());
  const [available,setAvailable]=useState(false),[error,setError]=useState('');
  const [pending,setPending]=useState<ReadonlySet<string>>(new Set());
  const identity=useRef<Identity|null>(null),generation=useRef(0),writes=useRef(new Set<string>());
  const key=ids.join(',');
  useEffect(()=>{
    const current=++generation.current;
    const controller=new AbortController();
    identity.current=null;setAvailable(false);setLiked(new Set());setError('');
    if(!enabled)return()=>controller.abort();
    void (async()=>{
      try {
        const tree=await native<AlbumTree>('albumTree',{},controller.signal);
        if(!tree.adopted||!tree.libraryId||tree.epoch===null)return;
        const scope={libraryId:tree.libraryId,epoch:tree.epoch};
        const members:Member[]=[];
        for(let start=0;start<Math.max(1,ids.length);start+=100) {
          const state=await api<LikesState>(likesPath(scope,ids.slice(start,start+100)),controller.signal);
          members.push(...state.memberships);
        }
        if(current!==generation.current||controller.signal.aborted)return;
        identity.current=scope;setLiked(new Set(members.filter(member=>member.desiredState).map(member=>member.assetId)));setAvailable(true);
      } catch { /* Unsupported or inactive authority: no misleading heart. */ }
    })();
    return()=>controller.abort();
  // The key fixes the requested set without restarting for an equivalent array.
  },[key,enabled,revision]);
  const toggle=useCallback(async(assetId:string)=>{
    const scope=identity.current,current=generation.current;
    if(!scope||writes.current.has(assetId))return;
    writes.current.add(assetId);setPending(new Set(writes.current));setError('');
    try {
      const command=(commandType:string,fields:Record<string,unknown>)=>api<{album?:{id:string};membership?:Member}>('/v1/albums/commands',undefined,
        {...scope,contractVersion:1,operationId:crypto.randomUUID(),commandType,...fields},'PUT');
      const ensured=await command('ensureLikesAlbum',{albumId:crypto.randomUUID()});
      if(current!==generation.current)return;
      if(!ensured.album?.id)throw new Error('마음에 들어요 앨범을 찾을 수 없습니다.');
      const state=await api<LikesState>(likesPath(scope,[assetId]));
      if(current!==generation.current)return;
      const member=state.memberships.find(member=>member.assetId===assetId);
      if(!member||state.albumId!==ensured.album.id)throw new Error('좋아요 상태를 다시 불러와 주세요.');
      const desiredState=!member.desiredState;
      await command('setAlbumMembership',{albumId:state.albumId,assetId,desiredState,expectedRevision:member.entityRevision});
      if(current===generation.current){
        setLiked(previous=>{const next=new Set(previous);if(desiredState)next.add(assetId);else next.delete(assetId);return next;});
        window.dispatchEvent(new Event(ASSET_LIST_CHANGED_EVENT));
      }
    } catch(reason) {if(current===generation.current)setError(errorText(reason)||'좋아요를 변경하지 못했습니다.');}
    finally {writes.current.delete(assetId);setPending(new Set(writes.current));}
  },[]);
  return {liked,available,pending,error,toggle};
}
