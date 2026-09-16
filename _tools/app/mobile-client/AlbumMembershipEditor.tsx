import {useCallback,useEffect,useRef,useState} from 'react';
import {FolderIcon,XMarkIcon} from '@heroicons/react/24/outline';
import {Dialog,DialogDescription,IconButton} from './ui';
import {errorText,native} from './transport';

export interface MembershipAlbum {
  id:string;
  name:string;
  parentId:string|null;
  desiredState:boolean;
  pending:boolean;
  blocked:boolean;
  conflictCode:string|null;
}
export interface AlbumMembershipState {
  adopted:boolean;
  libraryId?:string|null;
  epoch?:number|null;
  albums:MembershipAlbum[];
}
export interface FlatMembershipAlbum {album:MembershipAlbum;depth:number}

export function flattenMembershipAlbums(albums:MembershipAlbum[]):FlatMembershipAlbum[] {
  const byParent=new Map<string|null,MembershipAlbum[]>(),known=new Set(albums.map(album=>album.id));
  const key=(parent:string|null)=>parent&&known.has(parent)?parent:null;
  for(const album of albums){const parent=key(album.parentId);const list=byParent.get(parent)??[];list.push(album);byParent.set(parent,list);}
  const sort=(rows:MembershipAlbum[])=>rows.sort((a,b)=>a.name.localeCompare(b.name,'ko')||a.id.localeCompare(b.id));
  for(const rows of byParent.values())sort(rows);
  const result:FlatMembershipAlbum[]=[],seen=new Set<string>();
  const visit=(album:MembershipAlbum,depth:number)=>{if(seen.has(album.id))return;seen.add(album.id);result.push({album,depth});for(const child of byParent.get(album.id)??[])visit(child,depth+1);};
  for(const album of byParent.get(null)??[])visit(album,0);
  for(const album of sort([...albums]))if(!seen.has(album.id))visit(album,0);
  return result;
}

export function AlbumMembershipEditor({assetId,open,onClose}:{assetId:string;open:boolean;onClose():void}) {
  const [state,setState]=useState<AlbumMembershipState|null>(null);
  const [error,setError]=useState('');
  const [saving,setSaving]=useState<Set<string>>(new Set());
  const alive=useRef(0);
  const load=useCallback(async(signal?:AbortSignal)=>{
    const generation=alive.current;
    try{
      const next=await native<AlbumMembershipState>('albumMemberships',{assetId},signal);
      if(generation===alive.current&&!signal?.aborted){setState(next);setError('');}
    }catch(reason){if(generation===alive.current&&!signal?.aborted)setError(errorText(reason));}
  },[assetId]);
  useEffect(()=>{
    if(!open)return;
    alive.current++;
    const controller=new AbortController();
    void load(controller.signal);
    const timer=window.setInterval(()=>void load(),5000);
    return()=>{alive.current++;controller.abort();window.clearInterval(timer);};
  },[open,load]);
  const toggle=async(album:MembershipAlbum)=>{
    if(album.blocked||saving.has(album.id)||!state)return;
    const desired=!album.desiredState,previous=state;
    setState({...state,albums:state.albums.map(row=>row.id===album.id?{...row,desiredState:desired,pending:true}:row)});
    setSaving(current=>new Set(current).add(album.id));setError('');
    try{
      const next=await native<AlbumMembershipState>('albumMembershipSet',{assetId,albumId:album.id,desiredState:desired});
      setState(next);
    }catch(reason){setState(previous);setError(errorText(reason));}
    finally{setSaving(current=>{const next=new Set(current);next.delete(album.id);return next;});}
  };
  return <Dialog open={open} title="앨범" onClose={onClose}>
    <DialogDescription className="sr-only">현재 자산을 앨범에 추가하거나 제거합니다. 오프라인 변경은 저장 대기 상태로 유지됩니다.</DialogDescription>
    <div className="dialog-header"><span>앨범에 추가</span><IconButton label="앨범 선택 닫기" icon={XMarkIcon} onClick={onClose}/></div>
    {!state&&!error&&<div className="loading-line" role="status" aria-label="앨범 상태를 불러오는 중"/>}
    {error&&<p className="error-message" role="alert">{error}</p>}
    {state&&!state.adopted&&<p className="hint">앨범 동기화가 준비된 뒤 편집할 수 있습니다.</p>}
    {state?.adopted&&<div className="album-membership-list">{flattenMembershipAlbums(state.albums).map(({album,depth})=><label key={album.id} className={`album-membership-row${album.blocked?' is-blocked':''}`} style={{paddingLeft:12+depth*20}}>
      <input type="checkbox" aria-label={album.name} checked={album.desiredState} disabled={album.blocked||saving.has(album.id)} onChange={()=>void toggle(album)}/>
      <FolderIcon/><span className="album-membership-name">{album.name}</span>
      {album.blocked?<small role="status">동기화 충돌</small>:album.pending?<small role="status">저장 대기</small>:null}
    </label>)}</div>}
  </Dialog>;
}
