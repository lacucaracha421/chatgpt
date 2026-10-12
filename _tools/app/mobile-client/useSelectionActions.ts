import {useEffect,useRef,useState} from 'react';
import {api,errorText,native} from './transport';
import {albumBatchCommand,albumCommand} from './albumCommands';
import {batches,manyFailures,type ManyReply} from './batchCommands';
import type {AlbumTree} from './albumModel';
import type {AlbumMembershipState} from './AlbumMembershipEditor';
import {viewerEditEvent} from './listGeneration';
import {visibleInterval} from './useVisibleInterval';

export type SelectionAction = 'like'|'unlike'|'trash'|'remove';

/** Serialize single-asset commands, continuing after a failure and retaining only failures for retry. */
export function useSelectionActions({scope,selectedIds,tree,albumId,onTrash,onComplete}:{scope:string;selectedIds:ReadonlySet<string>;tree:AlbumTree|null;albumId?:string;onTrash(id:string):Promise<void>;onComplete(ids:string[],action:SelectionAction):void}) {
  const [busy,setBusy]=useState(false),[progress,setProgress]=useState({done:0,total:0}),[notice,setNotice]=useState('');
  const [removed,setRemoved]=useState<Record<string,ReadonlySet<string>>>({});
  const lock=useRef(false),generation=useRef(0);
  const hiddenIds=removed[scope];
  useEffect(()=>{generation.current++;setNotice('');},[scope]);
  useEffect(()=>()=>{generation.current++;},[]);
  useEffect(()=>{
    if(!albumId||!hiddenIds?.size)return;
    let active=true,running=false;
    const reconcile=async()=>{
      if(running||lock.current)return;
      running=true;
      try {
        for(const id of hiddenIds){
          if(!active)return;
          const state=await native<AlbumMembershipState>('albumMemberships',{assetId:id});
          if(!active)return;
          const member=state.albums?.find(item=>item.id===albumId);
          if(member?.blocked||member?.desiredState&&!member.pending){
            setRemoved(previous=>{const next=new Set(previous[scope]);next.delete(id);return {...previous,[scope]:next};});
            if(member.blocked)setNotice('앨범에서 빼기 전송에 실패했습니다. 해당 항목을 다시 표시했습니다. 정보의 앨범에서 충돌을 확인해 주세요.');
          }
        }
      } catch { /* Offline keeps the queued choice visible; the native outbox remains durable. */ }
      finally {running=false;}
    };
    const stop=visibleInterval(()=>void reconcile(),10_000,true);
    return()=>{active=false;stop();};
  },[scope,albumId,hiddenIds]);
  const run=async(action:SelectionAction)=>{
    if(lock.current||!selectedIds.size)return;
    lock.current=true;setBusy(true);setNotice('');
    const ids=[...selectedIds],current=generation.current,successful:string[]=[],failed:string[]=[];
    let firstError='';
    const record=(id:string,problem:string|null)=>{
      if(problem===null)successful.push(id);
      else{failed.push(id);if(!firstError)firstError=problem;}
    };
    setProgress({done:0,total:ids.length});
    try {
      let likesId:string|undefined;
      if(action==='like'||action==='unlike') {
        if(!tree)throw new Error('앨범 동기화가 준비된 뒤 편집할 수 있습니다.');
        const reply=await albumCommand<{album?:{id:string}}>(tree,'ensureLikesAlbum',{albumId:crypto.randomUUID()});
        likesId=reply.album?.id;
        if(!likesId)throw new Error('마음에 들어요 앨범을 찾을 수 없습니다.');
      }
      if(action==='trash') {
        // Trash stays per item: each Asset is one recoverable lifecycle intent.
        for(const [index,id] of ids.entries()) {
          if(current!==generation.current)break;
          try {await onTrash(id);record(id,null);} catch(reason) {record(id,errorText(reason));}
          if(current===generation.current)setProgress({done:index+1,total:ids.length});
        }
      } else {
        // Album membership and favorites go out in requests of at most 100 Assets; every Asset keeps its own outcome.
        for(const chunk of batches(ids)) {
          if(current!==generation.current)break;
          let problems:(string|null)[];
          try {
            problems=action==='remove'?await removeFromAlbum(chunk):await setLikes(chunk,action==='like',likesId!);
          } catch(reason) {problems=chunk.map(()=>errorText(reason));}
          if(current!==generation.current)break;
          chunk.forEach((id,index)=>record(id,problems[index]));
          setProgress({done:successful.length+failed.length,total:ids.length});
        }
      }
      if(current===generation.current) {
        if(action==='remove'&&successful.length)setRemoved(previous=>({...previous,[scope]:new Set([...(previous[scope]??[]),...successful])}));
        onComplete(successful,action);
        if(successful.length)window.dispatchEvent(viewerEditEvent());
        if(failed.length)setNotice(`${ids.length}개 중 ${successful.length}개 완료, ${failed.length}개 실패. 실패한 항목의 선택을 유지했습니다. ${firstError}`);
      }
    } catch(reason) {if(current===generation.current)setNotice(errorText(reason));}
    finally {lock.current=false;setBusy(false);}
  };
  const removeFromAlbum=async(chunk:string[]):Promise<(string|null)[]> => {
    if(!albumId)throw new Error('앨범을 다시 열어 주세요.');
    const reply=await native<ManyReply>('albumMembershipSetMany',{albumId,assetIds:chunk,desiredState:false});
    return manyFailures(chunk,reply,'앨범에서 빼지 못했습니다. 다시 시도해 주세요.');
  };
  const setLikes=async(chunk:string[],liked:boolean,likesId:string):Promise<(string|null)[]> => {
    const state=await api<{albumId:string|null;memberships:{assetId:string;desiredState:boolean;entityRevision:number}[]}>(`/v1/albums/likes?libraryId=${encodeURIComponent(tree!.libraryId!)}&epoch=${tree!.epoch}&assetIds=${encodeURIComponent(chunk.join(','))}`);
    if(state.albumId!==likesId)return chunk.map(()=>'좋아요 상태를 다시 불러와 주세요.');
    const problems:(string|null)[]=chunk.map(()=>null),commands:Record<string,unknown>[]=[],commandIndex:number[]=[];
    chunk.forEach((id,index)=>{
      const member=state.memberships.find(item=>item.assetId===id);
      if(!member)problems[index]='좋아요 상태를 다시 불러와 주세요.';
      else if(member.desiredState!==liked){
        commands.push({commandType:'setAlbumMembership',albumId:likesId,assetId:id,desiredState:liked,expectedRevision:member.entityRevision});
        commandIndex.push(index);
      }
    });
    const outcomes=commands.length?await albumBatchCommand(tree!,commands):[];
    outcomes.forEach((outcome,position)=>{
      if(outcome.status==='applied'||outcome.status==='noop')return;
      problems[commandIndex[position]]=outcome.status==='conflict'?'다른 기기에서 먼저 바뀌었습니다. 다시 시도해 주세요.':outcome.error?.message||'좋아요를 바꾸지 못했습니다.';
    });
    return problems;
  };
  return {busy,progress,notice,run,hiddenIds};
}
