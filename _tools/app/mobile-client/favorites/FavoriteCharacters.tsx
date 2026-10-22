import {useCallback,useEffect,useMemo,useRef,useState,type MutableRefObject,type ReactNode} from 'react';
import {EllipsisHorizontalIcon,InformationCircleIcon,PlusIcon} from '@heroicons/react/24/outline';
import {useLongPress} from '../../src/shared/useLongPress';
import {BusyLabel} from '../../src/shared/ui/BusyLabel';
import {createKoreanMatcher} from '../../src/shared/koreanSearch';
import type {FavoriteEntry} from '../../src/library/types';
import {Overlay} from '../Overlay';
import {BottomSheet} from '../BottomSheet';
import {Button,Checkbox,EmptyState,IconButton,SegmentedControl,TextInput} from '../ui';
import {api,errorText} from '../transport';
import {isExtrasNode,validCharacterIndex,type CharacterIndex,type CharacterNode} from '../characterModel';
import type {ClassificationList} from '../types';
import type {CollectionSummary} from '../collectionModel';
import {useSyncSignal} from '../syncSignals';
import {CharacterImage,CharacterPortrait} from './CharacterAssets';
import {CharacterDetail} from './CharacterDetail';
import {CoverSheet} from './CoverSheet';
import {useFavorites} from './useFavorites';
import {containerId,createFavoriteCommand,isManualFavorite,linkFavoriteCommand,favoriteFolders,favoriteNode,favoriteScopes,indexFavoriteTargets,reorderCommand,visibleFavorites} from './model';
import {useFavoriteHero} from './useFavoriteHero';
import './favorites.css';

function CharacterCard({entry,node,index,series,onOpen,onActions}:{entry:FavoriteEntry;node:CharacterNode;index:CharacterIndex;series:string;onOpen():void;onActions():void}) {
  const press=useLongPress({onLongPress:onActions});
  return <button data-favorite-card={entry.characterId} className="favorite-card" aria-label={`${node.name}${series?` · ${series}`:''}`} {...press.bind} onClick={press.click(onOpen)}>
    <span className="favorite-portrait"><CharacterPortrait entry={entry} node={node} index={index}/></span>
    <strong>{node.name}</strong><small className="favorite-meta">{series}</small>
  </button>;
}

export function FavoriteCharacters({open,covered,active,onClose,backRef,onOpenFolder,onOpenWork,cover}:{open:boolean;covered:boolean;active:boolean;onClose():void;backRef:MutableRefObject<(()=>boolean)|null>;onOpenFolder(node:CharacterNode):void;onOpenWork(id:string):void;cover(work:CollectionSummary,revision:string):ReactNode}) {
  const favorites=useFavorites(open&&active);
  const [source,setSource]=useState<{index:CharacterIndex;folders:ClassificationList['items']}|null>(null),[sourceError,setSourceError]=useState(''),[sourceBusy,setSourceBusy]=useState(false),[retry,setRetry]=useState(0);
  const [scope,setScope]=useState('all'),[sheet,setSheet]=useState<'add'|'link'|'actions'|'cover'|null>(null),[subject,setSubject]=useState<string|null>(null);
  const hero=useFavoriteHero(),{selected}=hero;
  const [linkDestination,setLinkDestination]=useState<{from:string;id:string}|null>(null);
  const selectedId=linkDestination&&selected===linkDestination.from&&favorites.document?.entries.some(entry=>entry.characterId===linkDestination.id)?linkDestination.id:hero.displayed;
  const shownDetail=useRef(selectedId);shownDetail.current=selectedId;
  const detailBack=useRef<(()=>boolean)|null>(null),childBack=useRef<(()=>boolean)|null>(null);
  useSyncSignal('characters',()=>setRetry(n=>n+1),open&&active);
  useSyncSignal('listGeneration',()=>setRetry(n=>n+1),open&&active);
  useEffect(()=>{
    if(!open||!active)return;
    const controller=new AbortController();setSourceBusy(true);
    void Promise.all([api<CharacterIndex>('/v1/library/characters',controller.signal),api<ClassificationList>('/v1/library/classifications?subtree_counts=1',controller.signal)])
      .then(([index,folders])=>{
        if(!validCharacterIndex(index))throw new Error('캐릭터 목록을 불러오지 못했습니다.');
        if(!controller.signal.aborted){setSource({index,folders:folders.items});setSourceError('');}
      }).catch(reason=>{if(!controller.signal.aborted)setSourceError(errorText(reason));})
      .finally(()=>{if(!controller.signal.aborted)setSourceBusy(false);});
    const resume=()=>setRetry(n=>n+1);window.addEventListener('lakomics-resume',resume);
    return()=>{controller.abort();window.removeEventListener('lakomics-resume',resume);};
  },[open,active,retry]);
  const close=useCallback(()=>{hero.reset();setSheet(null);onClose();},[onClose,hero.reset]);
  const back=useCallback(()=>{
    if(childBack.current?.())return true;
    if(sheet){setSheet(null);return true;}
    if(detailBack.current?.())return true;
    if(selected||hero.pending){hero.close();return true;}
    if(open){close();return true;}
    return false;
  },[open,selected,sheet,close,hero.pending,hero.close]);
  useEffect(()=>{backRef.current=back;return()=>{backRef.current=null;};},[back,backRef]);
  const folders=useMemo(()=>favoriteFolders(source?.folders??[]),[source?.folders]);
  const targets=useMemo(()=>source?indexFavoriteTargets(source.index,favorites.document?.entries??[]):[],[source?.index,favorites.document]);
  const entries=source?visibleFavorites(favorites.document?.entries??[],source.index):[];
  const scopes=favoriteScopes(targets,folders);
  const currentScope=scopes.some(option=>option.value===scope)?scope:'all';
  const visible=entries.filter(entry=>currentScope==='all'||containerId(targets.find(target=>target.id===entry.characterId)!,folders)===currentScope);
  const index=source?.index;
  const series=(node:CharacterNode)=>isManualFavorite(node.sourceId)?favorites.document?.entries.find(entry=>entry.characterId===node.sourceId)?.seriesName??'':index?.nodes.find(item=>item.kind==='series'&&item.sourceId===node.seriesId)?.name??source?.folders.find(folder=>folder.id===node.seriesId)?.name??'';
  const current=entries.find(entry=>entry.characterId===selectedId),actionEntry=entries.find(entry=>entry.characterId===subject);
  const node=current&&index?favoriteNode(index,current.characterId,current):undefined,actionNode=actionEntry&&index?favoriteNode(index,actionEntry.characterId,actionEntry):undefined;
  useEffect(()=>{
    if(!source||!favorites.document)return;
    if((selected||hero.pending)&&!node)hero.reset();
    if((sheet==='actions'||sheet==='cover')&&!actionNode)setSheet(null);
  },[source?.index.ready,favorites.document,selected,node,sheet,actionNode]);
  const move=async(destination:number)=>{
    if(!actionEntry||!favorites.document)return;
    const ids=visible.map(entry=>entry.characterId),reordered=ids.filter(id=>id!==actionEntry.characterId);
    reordered.splice(destination,0,actionEntry.characterId);
    const command=reorderCommand(favorites.document.entries,ids,reordered);
    if(!command||await favorites.change(command))setSheet(null);
  };
  const remove=async()=>{
    if(!actionEntry)return;
    if(await favorites.change({op:'remove',ids:[actionEntry.characterId]})){
      setSheet(null);if(selected===actionEntry.characterId)hero.reset();
    }
  };
  const link=async(id:string)=>{
    if(!current)return false;
    setLinkDestination({from:current.characterId,id});
    const saved=await favorites.change(linkFavoriteCommand(current.characterId,id));
    const stillHere=shownDetail.current===current.characterId||shownDetail.current===id;
    if(saved&&stillHere)hero.replace(id);
    setLinkDestination(null);
    return saved&&stillHere;
  };
  const error=favorites.error||sourceError;
  return <>
    <div ref={hero.grid} className="favorite-layer"><Overlay retainLayout open={open} covered={covered||!active||!!selected} title="캐릭터" count={entries.length} onClose={close} headerActions={<IconButton label="캐릭터 추가" icon={PlusIcon} onClick={()=>setSheet('add')}/> }>
      <div className="favorite-scroll" inert={!!hero.pending||undefined}>
        {error&&<p className="inline-error" role="alert">{error}<Button variant="ghost" onClick={()=>{favorites.refresh();setRetry(n=>n+1);}}>다시 시도</Button></p>}
        <BusyLabel busy={favorites.busy||sourceBusy||!!hero.pending} delay={400}><p className="hint" role="status">불러오는 중…</p></BusyLabel>
        <SegmentedControl fullWidth label="분류함" options={scopes} value={currentScope} onChange={setScope}/>
        {index&&favorites.document&&<div className="favorite-grid">{visible.map(entry=>{const node=favoriteNode(index,entry.characterId,entry)!;return <CharacterCard key={entry.characterId} entry={entry} node={node} index={index} series={series(node)} onOpen={()=>hero.open(entry.characterId)} onActions={()=>{setSubject(entry.characterId);setSheet('actions');}}/>;})}</div>}
        {favorites.document&&source&&!sourceBusy&&!visible.length&&<EmptyState inline title="고른 캐릭터가 없습니다"/>}
      </div>
    </Overlay></div>
    <div ref={hero.detail} className="favorite-layer"><Overlay preparing={!!hero.pending} noMotion={hero.noMotion} open={open&&!!current&&!!node} covered={covered||!active} title={node?.name??'캐릭터'} onClose={hero.close} onBack={hero.close} headerActions={<IconButton label="캐릭터 더보기" icon={EllipsisHorizontalIcon} onClick={()=>{setSubject(current?.characterId??null);setSheet('actions');}}/>}>
      {current&&node&&index&&<CharacterDetail key={node.id} entry={current} node={node} index={index} series={series(node)} active={open&&active&&!covered} backRef={detailBack} onOpenWork={onOpenWork} cover={cover} onLink={()=>setSheet('link')} onReady={hero.ready}/>}
    </Overlay></div>
    {open&&active&&!covered&&sheet==='actions'&&actionEntry&&actionNode&&index&&<BottomSheet title={actionNode.name} onClose={()=>setSheet(null)} heading={<><span className="favorite-subject-image"><CharacterPortrait entry={actionEntry} node={actionNode} index={index}/></span><span><strong>{actionNode.name}</strong><small className="favorite-meta">{series(actionNode)}{!isManualFavorite(actionEntry.characterId)&&` · ${(index.scopes.find(scope=>scope.nodeId===actionNode.id&&scope.filter==='all')?.totalCount??0).toLocaleString('ko-KR')}장`}</small></span></>}>
      {favorites.error&&<p role="alert">{favorites.error}</p>}
      {!isManualFavorite(actionEntry.characterId)&&<><button className="sheet-option" disabled={favorites.busy} onClick={()=>setSheet('cover')}>대표 이미지 바꾸기</button>
      <button className="sheet-option" onClick={()=>{setSheet(null);close();onOpenFolder(actionNode);}}>에셋 폴더 열기</button></>}
      {!selected&&<>{(['앞으로','뒤로','맨 앞으로','맨 뒤로'] as const).map((label,i)=>{
        const at=visible.findIndex(entry=>entry.characterId===actionEntry.characterId),to=[at-1,at+1,0,visible.length-1][i];
        return <button className="sheet-option" key={label} disabled={favorites.busy||to<0||to>=visible.length||to===at} onClick={()=>{void move(to);}}>{label}</button>;
      })}<hr/></>}
      <button className="sheet-option" disabled={favorites.busy} onClick={()=>{void remove();}}>캐릭터 목록에서 빼기</button>
    </BottomSheet>}
    {open&&active&&!covered&&sheet==='cover'&&actionEntry&&!isManualFavorite(actionEntry.characterId)&&actionNode&&index?.revision&&<>
      <CoverSheet entry={actionEntry} node={actionNode} revision={index.revision} busy={favorites.busy} error={favorites.error} onClose={()=>setSheet(null)} onSave={(coverAssetId,coverY)=>favorites.change({op:'update',id:actionEntry.characterId,set:{coverAssetId,coverY}})}/>
    </>}
    {open&&active&&!covered&&(sheet==='add'||sheet==='link')&&source&&<AddSheet index={source.index} folders={folders} entries={entries} busy={favorites.busy} error={favorites.error} backRef={childBack} onClose={()=>setSheet(null)} onAdd={ids=>favorites.change({op:'add',ids})} onCreate={name=>favorites.change(createFavoriteCommand(name))} onLink={sheet==='link'?link:undefined}/>}
  </>;
}

function AddSheet({index,folders,entries,busy,error,backRef,onClose,onAdd,onCreate,onLink}:{index:CharacterIndex;folders:ReturnType<typeof favoriteFolders>;entries:FavoriteEntry[];busy:boolean;error:string;backRef:MutableRefObject<(()=>boolean)|null>;onClose():void;onAdd(ids:string[]):Promise<boolean>;onCreate(name:string):Promise<boolean>;onLink?(id:string):Promise<boolean>}) {
  const [query,setQuery]=useState(''),[scope,setScope]=useState('all'),[chosen,setChosen]=useState<Set<string>>(new Set()),[help,setHelp]=useState(false);
  const targets=useMemo(()=>index.ready?indexFavoriteTargets(index):[],[index]);
  const scopes=favoriteScopes(targets,folders),added=new Set(entries.map(entry=>entry.characterId));
  const matches=createKoreanMatcher(query);
  const rows=index.ready?index.nodes.filter(node=>node.kind==='character'&&!isExtrasNode(node)&&targets.some(target=>target.id===node.sourceId&&(scope==='all'||containerId(target,folders)===scope))):[];
  const series=(node:CharacterNode)=>index.nodes.find(item=>item.kind==='series'&&item.sourceId===node.seriesId)?.name??folders.find(folder=>folder.id===node.seriesId)?.name??'';
  const visible=rows.filter(node=>matches(`${node.name} ${entries.find(entry=>entry.characterId===node.sourceId)?.profile.originalName??''} ${series(node)}`));
  const groups=new Map<string,CharacterNode[]>();for(const node of visible)groups.set(node.seriesId,[...(groups.get(node.seriesId)??[]),node]);
  const ids=[...chosen].filter(id=>!added.has(id)&&targets.some(target=>target.id===id));
  useEffect(()=>{backRef.current=()=>{if(!help)return false;setHelp(false);return true;};return()=>{backRef.current=null;};},[help,backRef]);
  return <BottomSheet title={onLink?'에셋 캐릭터와 연결':'캐릭터 추가'} tall onClose={onClose}>
    <div className="favorite-picker">
      <div className="favorite-picker-search"><TextInput aria-label="이름 · 작품 검색" placeholder="이름 · 작품 검색" maxLength={120} value={query} onChange={event=>setQuery(event.target.value)}/>{!onLink&&<IconButton label="캐릭터 추가 도움말" icon={InformationCircleIcon} onClick={()=>setHelp(true)}/>}</div>
      <SegmentedControl fullWidth label="분류함" options={scopes} value={scope} onChange={setScope}/>
      <div className="favorite-picker-rows">{!onLink&&query.trim()&&<button className="favorite-picker-row favorite-picker-select" disabled={busy||entries.length>=300} onClick={()=>{void onCreate(query.trim()).then(saved=>{if(saved)onClose();});}}>'{query.trim()}' 이름으로 추가</button>}{[...groups].map(([id,nodes])=><section key={id}><h3 className="favorite-meta">{series(nodes[0])}</h3>{nodes.map(node=>{
        const already=added.has(node.sourceId),entry=entries.find(entry=>entry.characterId===node.sourceId);
        if(onLink)return <button key={node.id} className="favorite-picker-row favorite-picker-select" disabled={already||busy} onClick={()=>{void onLink(node.sourceId).then(saved=>{if(saved)onClose();});}}>
          <span className="favorite-subject-image"><CharacterImage id={node.thumbnailAssetId} rating={index.contentRatings?.[node.thumbnailAssetId??'']}/></span><span className="favorite-picker-name">{node.name}</span>{already&&<> <small className="favorite-meta">추가됨</small></>}
        </button>;
        return <label key={node.id} className={`favorite-picker-row${already?' is-added':''}`}>
          <Checkbox aria-label={node.name} checked={already||chosen.has(node.sourceId)} disabled={already||busy} onChange={()=>setChosen(before=>{const next=new Set(before);if(next.has(node.sourceId))next.delete(node.sourceId);else next.add(node.sourceId);return next;})}/>
          <span className="favorite-subject-image"><CharacterImage id={node.thumbnailAssetId} rating={index.contentRatings?.[node.thumbnailAssetId??'']}/></span>
          <span className="favorite-picker-name"><strong>{node.name}</strong>{entry?.profile.originalName&&<small className="favorite-meta">{entry.profile.originalName}</small>}</span>
          <small className="favorite-meta">{already?'추가됨':`${(index.scopes.find(scope=>scope.nodeId===node.id&&scope.filter==='all')?.totalCount??0).toLocaleString('ko-KR')}장`}</small>
        </label>;
      })}</section>)}{!visible.length&&<EmptyState inline title={query?'검색 결과 없음':'추가할 캐릭터가 없습니다'}/>}</div>
      {error&&<p role="alert">{error}</p>}
      {!onLink&&<Button className="favorite-apply" disabled={!ids.length||busy||entries.length+ids.length>300} onClick={()=>{void onAdd(ids).then(saved=>{if(saved)onClose();});}}>{ids.length.toLocaleString('ko-KR')}명 추가</Button>}
    </div>
    {help&&<BottomSheet title="캐릭터 추가 도움말" stacked onClose={()=>setHelp(false)}><p>에셋에 없는 캐릭터도 이름으로 추가할 수 있습니다.</p></BottomSheet>}
  </BottomSheet>;
}
