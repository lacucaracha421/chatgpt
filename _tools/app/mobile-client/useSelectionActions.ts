import {useEffect,useRef,useState} from 'react';
import {api,errorText,native} from './transport';
import {albumCommand} from './albumCommands';
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
    setProgress({done:0,total:ids.length});
    try {
      let likesId:string|undefined;
      if(action==='like'||action==='unlike') {
        if(!tree)throw new Error('앨범 동기화가 준비된 뒤 편집할 수 있습니다.');
        const reply=await albumCommand<{album?:{id:string}}>(tree,'ensureLikesAlbum',{albumId:crypto.randomUUID()});
        likesId=reply.album?.id;
        if(!likesId)throw new Error('마음에 들어요 앨범을 찾을 수 없습니다.');
      }
      for(const [index,id] of ids.entries()) {
        if(current!==generation.current)break;
        try {
          if(action==='trash')await onTrash(id);
          else if(action==='remove') {
            if(!albumId)throw new Error('앨범을 다시 열어 주세요.');
            const state=await native<AlbumMembershipState>('albumMembershipSet',{assetId:id,albumId,desiredState:false});
            const member=state.albums?.find(item=>item.id===albumId);
            if(!state.adopted||!member||member.blocked||member.desiredState)throw new Error('앨범에서 빼지 못했습니다. 다시 시도해 주세요.');
          } else {
            const state=await api<{albumId:string|null;memberships:{assetId:string;desiredState:boolean;entityRevision:number}[]}>(`/v1/albums/likes?libraryId=${encodeURIComponent(tree!.libraryId!)}&epoch=${tree!.epoch}&assetIds=${encodeURIComponent(id)}`);
            const member=state.memberships.find(item=>item.assetId===id);
            if(state.albumId!==likesId||!member)throw new Error('좋아요 상태를 다시 불러와 주세요.');
            if(current!==generation.current)break;
            if(member.desiredState!==(action==='like'))await albumCommand(tree!,'setAlbumMembership',{albumId:likesId,assetId:id,desiredState:action==='like',expectedRevision:member.entityRevision});
          }
          successful.push(id);
        } catch(reason) {failed.push(id);if(!firstError)firstError=errorText(reason);}
        if(current===generation.current)setProgress({done:index+1,total:ids.length});
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
  return {busy,progress,notice,run,hiddenIds};
}
