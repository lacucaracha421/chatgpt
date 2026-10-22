import {useEffect,useRef,useState,type MutableRefObject,type ReactNode} from 'react';
import {PlusIcon} from '@heroicons/react/24/outline';
import type {FavoriteEntry} from '../../src/library/types';
import {BusyLabel} from '../../src/shared/ui/BusyLabel';
import {Button,DDay,SectionLabel} from '../ui';
import {Gallery} from '../Gallery';
import {Viewer} from '../Viewer';
import {markViewerOpen} from '../perf';
import {api,errorText} from '../transport';
import type {CharacterIndex,CharacterNode} from '../characterModel';
import type {CollectionSummary} from '../collectionModel';
import {birthdayDays,favoriteFacts,hasFavoriteProfile,isManualFavorite,representativeAsset} from './model';
import {CharacterPortrait,useCharacterAssets} from './CharacterAssets';

export function CharacterDetail({entry,node,index,series,active,backRef,onOpenWork,cover,onLink,onEdit,onWorks,onReady}:{entry:FavoriteEntry;node:CharacterNode;index:CharacterIndex;series:string;active:boolean;backRef:MutableRefObject<(()=>boolean)|null>;onOpenWork(id:string):void;cover(work:CollectionSummary,revision:string):ReactNode;onLink():void;/** 정보 추가 / 정보 편집. */onEdit():void;/** The linked works as read, so the editor names them. */onWorks?(works:CollectionSummary[]):void;onReady():void}) {
  const manual=isManualFavorite(entry.characterId);
  const assets=useCharacterAssets(node.id,index.revision??'',active&&!manual);
  const [portraitReady,setPortraitReady]=useState<string|null|undefined>();
  const portraitId=representativeAsset(entry,{id:entry.characterId,thumbnailAssetId:node.thumbnailAssetId},assets.page?.items[0]?.id);
  const ready=useRef(onReady);ready.current=onReady;
  useEffect(()=>{if(portraitReady===portraitId&&(manual||assets.page||assets.error))ready.current();},[portraitReady,portraitId,manual,assets.page,assets.error]);
  const [works,setWorks]=useState<{revision:string;item:CollectionSummary}[]>([]),[workError,setWorkError]=useState(''),[retry,setRetry]=useState(0);
  const [viewer,setViewer]=useState<number|null>(null),viewerBack=useRef<(()=>boolean)|null>(null),scroll=useRef(0);
  const workKey=JSON.stringify(entry.workIds),worksRead=useRef(onWorks);worksRead.current=onWorks;
  useEffect(()=>{
    if(!active)return;
    const controller=new AbortController();
    void Promise.all(entry.workIds.map(id=>api<{revision:string;item:CollectionSummary}>(`/v1/collections/${encodeURIComponent(id)}`,controller.signal)))
      .then(reply=>{if(!controller.signal.aborted){setWorks(reply);setWorkError('');worksRead.current?.(reply.map(work=>work.item));}},reason=>{if(!controller.signal.aborted)setWorkError(errorText(reason));});
    return()=>controller.abort();
  },[workKey,active,retry]);
  useEffect(()=>{
    backRef.current=()=>{if(viewer===null)return false;if(!viewerBack.current?.())setViewer(null);return true;};
    return()=>{backRef.current=null;};
  },[viewer,backRef]);
  const profile=entry.profile;
  const intro=<div className="favorite-detail">
    <div className="favorite-detail-top">
      <div className="favorite-portrait"><CharacterPortrait entry={entry} node={node} index={index} firstAsset={assets.page?.items[0]} onPrepared={setPortraitReady}/></div>
      <div className="favorite-profile"><h3>{node.name}</h3><p className="favorite-meta">{[profile.originalName,series].filter(Boolean).join(' · ')}</p>
        <dl>{favoriteFacts(profile).map(row=><div key={row.label}><dt>{row.label}</dt><dd>{row.value}{row.birthday&&<> <DDay as="text" className="favorite-meta" days={birthdayDays(profile.birthMonth,profile.birthDay)}/></>}</dd></div>)}</dl>
        {!hasFavoriteProfile(profile)&&<Button variant="quiet" onClick={onEdit}><PlusIcon aria-hidden="true"/>정보 추가</Button>}
      </div>
    </div>
    {(works.length>0||entry.extraWorks.length>0||workError)&&<section><SectionLabel title="등장 작품"/>
      <div className="favorite-works">{works.map(work=><button key={work.item.id} onClick={()=>onOpenWork(work.item.id)}>{cover(work.item,work.revision)}<span>{work.item.name}</span></button>)}</div>
      {entry.extraWorks.map((work,i)=><p className="favorite-meta" key={i}>{work}</p>)}
      {workError&&<p role="alert">{workError}<Button variant="ghost" onClick={()=>setRetry(n=>n+1)}>다시 시도</Button></p>}
    </section>}
    {manual?<div className="favorite-manual-assets"><span>에셋에 없는 캐릭터</span><Button variant="quiet" onClick={onLink}>에셋 캐릭터와 연결</Button></div>:<>
    <SectionLabel title="에셋" count={assets.page?.totalCount??index.scopes.find(scope=>scope.nodeId===node.id&&scope.filter==='all')?.totalCount??0} unit="장"/>
    <BusyLabel busy={assets.busy} delay={400}><span className="hint">불러오는 중…</span></BusyLabel>
    {assets.error&&<p role="alert">{assets.error}<Button variant="ghost" onClick={assets.reload}>다시 시도</Button></p>}
    {assets.page&&!assets.page.items.length&&<p className="hint">이미지 없음</p>}
    </>}
  </div>;
  return <>
    <Gallery items={assets.page?.items??[]} columns={3} density={1} identity={node.id} restoreScroll={scroll.current} onScroll={top=>{scroll.current=top;}} intro={intro}
      onOpen={position=>{markViewerOpen();setViewer(position);}} onReady={assets.ready} onNearEnd={assets.more} hasMore={assets.page?.has_more} busy={assets.busy} paused={!active||viewer!==null} scrubberHidden={viewer!==null} scrubberSort={{kind:'fallback'}}/>
    {active&&viewer!==null&&!!assets.page?.items.length&&<Viewer items={assets.page.items} index={viewer} onIndex={setViewer} onClose={()=>setViewer(null)} backRef={viewerBack} totalCount={assets.page.totalCount} onNearEnd={assets.more}/>}
  </>;
}
