import {useEffect,useRef,useState} from 'react';
import {Button,Dialog,DialogDescription,Field,TextInput} from './ui';
import {BottomSheet} from './BottomSheet';
import {BusyLabel} from '../src/shared/ui/BusyLabel';
import {AppearanceChoices} from './AppearanceChoices';
import {albumCommand,publishAlbumTree,readAlbumSnapshot,type AlbumSnapshot} from './albumCommands';
import type {AlbumTree,NativeAlbum} from './albumModel';
import {errorText} from './transport';
import './albumManagement.css';
import {breadcrumbPath} from '../src/shared/breadcrumb';

export function AlbumManagement({tree,album,parentId=null,initialMode,onClose,onDeleted}:{tree:AlbumTree;album?:NativeAlbum;parentId?:string|null;/** A long-press sheet that already chose the action opens straight on its form. */initialMode?:'create'|'rename'|'look'|'delete';onClose():void;onDeleted?():void}) {
  const [mode,setMode]=useState<'menu'|'create'|'rename'|'look'|'delete'|'move'>(initialMode??(album?'menu':'create'));
  const [destination,setDestination]=useState<string|null>(album?.parentId??null);
  const [name,setName]=useState(initialMode==='create'?'새 앨범':album?.name??'새 앨범');
  const [iconKey,setIcon]=useState(album?.iconKey??null),[colorKey,setColor]=useState(album?.colorKey??null);
  const [snapshot,setSnapshot]=useState<AlbumSnapshot|null>(null),[busy,setBusy]=useState(false),[error,setError]=useState('');
  const lock=useRef(false);
  const read=()=>{setError('');return readAlbumSnapshot(tree).then(setSnapshot,reason=>setError(errorText(reason)));};
  useEffect(()=>{let live=true;const controller=new AbortController();void readAlbumSnapshot(tree,controller.signal).then(value=>{if(live)setSnapshot(value);},reason=>{if(live)setError(errorText(reason));});return()=>{live=false;controller.abort();};},[tree.libraryId,tree.epoch]);
  const current=snapshot?.albums.find(item=>item.id===album?.id);
  const hasChildren=snapshot?.albums.some(item=>item.parentId===album?.id)??false;
  const deleteBlocked=!!album&&(snapshot?.likesAlbumId===album.id||hasChildren);
  const blockedParents=new Set<string>();
  if(album){
    blockedParents.add(album.id);
    let changed=true;
    while(changed){changed=false;for(const row of snapshot?.albums??[])if(row.parentId&&blockedParents.has(row.parentId)&&!blockedParents.has(row.id)){blockedParents.add(row.id);changed=true;}}
  }
  const moveBlocked=mode==='move'&&(destination===current?.parentId||(destination!==null&&(!snapshot?.albums.some(row=>row.id===destination)||blockedParents.has(destination))));
  const close=()=>{if(!lock.current)onClose();};
  const save=async()=>{
    if(lock.current||!snapshot||(album&&!current)||!name.trim())return;
    if(mode==='delete'&&deleteBlocked)return;
    if(moveBlocked)return;
    lock.current=true;setBusy(true);setError('');
    try {
      const id=mode==='create'?crypto.randomUUID():album!.id;
      const fields=mode==='create'?{albumId:id,name:name.trim(),parentId:album?.id??parentId,iconKey:null,colorKey:null}
        :mode==='rename'?{albumId:id,name:name.trim(),expectedRevision:current!.entityRevision}
        :mode==='look'?{albumId:id,iconKey,colorKey,expectedRevision:current!.entityRevision}
        :mode==='move'?{albumId:id,parentId:destination,expectedRevision:current!.entityRevision}
        :{albumId:id,expectedRevision:current!.entityRevision};
      const reply=await albumCommand<{album:{id:string;name:string;parentId:string|null;iconKey:string|null;colorKey:string|null;deleted:boolean;entityRevision:number}}>(tree,{create:'createAlbum',rename:'renameAlbum',look:'updateAlbumAppearance',move:'moveAlbum',delete:'deleteAlbum',menu:''}[mode],fields);
      if(!reply.album||reply.album.id!==id)throw new Error('변경 결과를 확인하지 못했습니다. 앨범 목록을 다시 확인해 주세요.');
      // Keep covers and the grid mounted; install only the confirmed entity change.
      const base=snapshot.albums.map(item=>({...tree.albums.find(old=>old.id===item.id),...item}));
      const albums=mode==='delete'?base.filter(item=>item.id!==id):mode==='create'?[...base,reply.album]:base.map(item=>item.id===id?{...item,...reply.album}:item);
      publishAlbumTree(tree,albums);
      if(mode==='delete')onDeleted?.();
      onClose();
    } catch(reason) {setError(errorText(reason));}
    finally {lock.current=false;setBusy(false);}
  };
  const title={menu:'앨범 관리',create:'새 앨범',rename:'이름 바꾸기',look:'아이콘 및 색상',move:'앨범 이동',delete:'앨범 삭제'}[mode];
  const contents=<>
    <BusyLabel delay={400} busy={!snapshot&&!error}>앨범 목록 확인 중</BusyLabel>
    {error&&<p role="alert" className="error-message">{error}<Button variant="ghost" disabled={busy} onClick={()=>void read()}>다시 시도</Button></p>}
    {album&&snapshot&&!current&&<p role="alert">이 앨범은 삭제되었습니다.</p>}
    {mode==='menu'?<div className="album-management-actions">
      <Button disabled={!current} onClick={()=>setMode('rename')}>이름 바꾸기</Button>
      <Button disabled={!current} onClick={()=>setMode('look')}>아이콘 및 색상</Button>
      <Button disabled={!current} onClick={()=>{setDestination(current?.parentId??null);setMode('move');}}>이동</Button>
      <Button disabled={!current} onClick={()=>{setName('새 앨범');setMode('create');}}>하위 앨범 만들기</Button>
      <Button variant="danger" disabled={!current||snapshot?.likesAlbumId===album?.id||hasChildren} onClick={()=>setMode('delete')}>삭제</Button>
      {snapshot?.likesAlbumId===album?.id&&<p className="hint">마음에 들어요 앨범은 삭제할 수 없습니다.</p>}
      {hasChildren&&<p className="hint">하위 앨범이 있는 앨범은 삭제할 수 없습니다.</p>}
    </div>:<>
      {(mode==='create'||mode==='rename')&&<Field label="앨범 이름"><TextInput value={name} disabled={busy} onChange={event=>setName(event.target.value)} autoFocus/></Field>}
      {mode==='look'&&<AppearanceChoices name={album?.name} kind="root" iconKey={iconKey} colorKey={colorKey} busy={busy} onIcon={setIcon} onColor={setColor} onReset={()=>{setIcon(null);setColor(null);}}/>}
      {mode==='move'&&<div role="group" aria-label="이동할 상위 앨범" className="album-management-actions"><Button disabled={busy} aria-pressed={destination===null} onClick={()=>setDestination(null)}>최상위</Button>{snapshot?.albums.filter(row=>!blockedParents.has(row.id)).map(row=><Button key={row.id} disabled={busy} aria-pressed={destination===row.id} onClick={()=>setDestination(row.id)}>{breadcrumbPath(row,snapshot.albums)}</Button>)}</div>}
      {mode==='delete'&&<DialogDescription>{album?.name} 앨범을 삭제할까요?<br/>앨범 연결만 제거되며 원본 파일과 일반 폴더는 유지됩니다.</DialogDescription>}
      {mode==='delete'&&snapshot&&deleteBlocked&&<p className="hint">{snapshot.likesAlbumId===album?.id?'마음에 들어요 앨범은 삭제할 수 없습니다.':'하위 앨범이 있는 앨범은 삭제할 수 없습니다.'}</p>}
      <div className="ui-dialog__actions"><Button disabled={busy} onClick={close}>취소</Button><Button variant={mode==='delete'?'danger':'primary'} disabled={busy||!snapshot||!!(album&&!current)||!name.trim()||moveBlocked||(mode==='delete'&&deleteBlocked)} onClick={()=>void save()}><BusyLabel delay={400} busy={busy} idle={mode==='delete'?'삭제':mode==='create'?'만들기':'저장'}>저장 중</BusyLabel></Button></div>
    </>}
  </>;
  return mode==='delete'?<Dialog open title={title} onClose={close}>{contents}</Dialog>:<BottomSheet title={title} onClose={close}><div className="album-management">{contents}</div></BottomSheet>;
}
