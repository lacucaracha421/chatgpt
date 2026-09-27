import {useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode, type PointerEvent as ReactPointerEvent} from 'react';
import {ArrowsUpDownIcon, ChevronDownIcon} from '@heroicons/react/24/outline';
import {StarIcon as StarOutline} from '@heroicons/react/24/outline';
import {StarIcon as StarSolid} from '@heroicons/react/24/solid';
import {BottomSheet} from './BottomSheet';
import {artworkTicket} from './Collections';
import {collectionCover, type AvPerson, type CollectionDetail, type CollectionFilters, type CollectionSummary} from './collectionModel';
import type {Ticket} from './types';
import './avCollections.css';

export type AvListView = 'works' | 'performers';
export const AV_LIST_VIEW_KEY = 'lakomics.mobile.avListView';

type AvItem = CollectionSummary & {type:'av'};
type ArtworkUrls = {front?:string;spine?:string;back?:string};

function dateLabel(value:string|null|undefined) {
  const match=/^(\d{4})-(\d{2})-(\d{2})$/.exec(value?.trim()??'');
  return match ? `${match[1]}.${match[2]}.${match[3]}` : value?.trim()??'';
}

function initials(value:string) {
  const parts=value.trim().split(/\s+/).filter(Boolean);
  return parts.length>1 ? `${Array.from(parts[0]!)[0]??''}${Array.from(parts[parts.length-1]!)[0]??''}`.toUpperCase() : Array.from(value.trim())[0]??'?';
}

function artworkId(item:CollectionSummary, kind:'cover'|'spine'|'back') {
  const found='artworks' in item ? (item.artworks as CollectionDetail['artworks']).find(art=>art.kind===kind)?.id : undefined;
  return found ?? (kind==='cover'?item.selectedWorkArtworkId:null);
}

function useArtworkUrls(item:CollectionSummary, ids:{front?:string|null;spine?:string|null;back?:string|null}, revision:string, original:boolean, active:boolean) {
  const key=JSON.stringify(ids);
  const [urls,setUrls]=useState<ArtworkUrls>({});
  useEffect(()=>{
    if(!active)return;
    const controller=new AbortController();
    const entries=Object.entries(ids).filter((entry):entry is [keyof ArtworkUrls,string]=>!!entry[1]) as [keyof ArtworkUrls,string][];
    void Promise.all(entries.map(async ([name,id])=>{
      try {
        const ticket=await artworkTicket(item,id,revision,original,controller.signal) as Ticket;
        return [name,ticket.url] as const;
      } catch { return [name,undefined] as const; }
    })).then(values=>{
      if(!controller.signal.aborted)setUrls(Object.fromEntries(values.filter(value=>!!value[1])) as ArtworkUrls);
    });
    return()=>controller.abort();
  },[active,item.id,key,original,revision]);
  return urls;
}

function AvStars({score}:{score:number|null|undefined}) {
  const value=score==null?0:Math.max(0,Math.min(5,score));
  return <span className="av-mobile-stars" aria-label={`내 별점 ${score==null?'없음':`${value.toFixed(1)}점`}`}>{[1,2,3,4,5].map(star=>star<=value?<StarSolid key={star} className="is-filled" aria-hidden="true"/>:<StarOutline key={star} aria-hidden="true"/>)}</span>;
}

type DvdPose='front'|'spine'|'back';
const POSE_ANGLES:Record<DvdPose,number>={front:0,spine:90,back:180};
const POSES:DvdPose[]=['front','spine','back'];
const nearestPose=(yaw:number):DvdPose=>POSES.reduce((best,candidate)=>{
  const distance=Math.abs((((POSE_ANGLES[candidate]-yaw+540)%360)-180));
  return distance<best.distance?{pose:candidate,distance}:best;
},{pose:'front' as DvdPose,distance:Number.POSITIVE_INFINITY}).pose;

function AvCase({urls,pose='front',interactive=false,size=150,alt='DVD 케이스',onPoseChange}:{urls:ArtworkUrls;pose?:DvdPose;interactive?:boolean;size?:number;alt?:string;onPoseChange?(pose:DvdPose):void}) {
  const [yaw,setYaw]=useState(POSE_ANGLES[pose]),[pitch,setPitch]=useState(0);
  const drag=useRef<{x:number;y:number;yaw:number;pitch:number}|null>(null);
  useEffect(()=>{if(!drag.current){setYaw(POSE_ANGLES[pose]);setPitch(0);}},[pose]);
  const apply=(next:number,nextPitch=pitch)=>{setYaw(next);setPitch(Math.max(-20,Math.min(20,nextPitch)));};
  const snap=()=>{const selected=nearestPose(yaw);setYaw(yaw+(((POSE_ANGLES[selected]-yaw+540)%360)-180));setPitch(0);onPoseChange?.(selected);};
  const handlers=interactive?{
    onPointerDown:(event:ReactPointerEvent<HTMLDivElement>)=>{drag.current={x:event.clientX,y:event.clientY,yaw,pitch};event.currentTarget.setPointerCapture?.(event.pointerId);},
    onPointerMove:(event:ReactPointerEvent<HTMLDivElement>)=>{if(drag.current)apply(drag.current.yaw+(event.clientX-drag.current.x)*.55,drag.current.pitch-(event.clientY-drag.current.y)*.25);},
    onPointerUp:()=>{if(drag.current){drag.current=null;snap();}},onPointerCancel:()=>{if(drag.current){drag.current=null;snap();}},
    onKeyDown:(event:React.KeyboardEvent<HTMLDivElement>)=>{if(!['ArrowLeft','ArrowRight','Home'].includes(event.key))return;event.preventDefault();const next=event.key==='Home'?'front':nearestPose(yaw+(event.key==='ArrowRight'?90:-90));setYaw(POSE_ANGLES[next]);setPitch(0);onPoseChange?.(next);},
  }:{};
  const width=Math.round(size*.703),depth=Math.max(10,Math.round(size*.076));
  const style={'--av-case-width':`${width}px`,'--av-case-height':`${size}px`,'--av-case-depth':`${depth}px`,'--av-case-yaw':`${yaw}deg`,'--av-case-pitch':`${pitch}deg`} as CSSProperties;
  return <div className={`av-case-stage${interactive?' is-interactive':''}`} style={{width:width+depth+18,height:size+24}} role="img" aria-label={alt} tabIndex={interactive?0:undefined} {...handlers}>
    <div className="av-case" style={style}>
      <div className={`av-case-face av-case-front${urls.front?'':' is-empty'}`}><ArtworkFace url={urls.front}/></div>
      <div className={`av-case-face av-case-back${urls.back?'':' is-empty'}`}><ArtworkFace url={urls.back}/></div>
      <div className={`av-case-face av-case-spine${urls.spine?'':' is-empty'}`}><ArtworkFace url={urls.spine}/></div>
      <div className="av-case-face av-case-edge"/><div className="av-case-face av-case-top"/><div className="av-case-face av-case-bottom"/>
    </div>
  </div>;
}

function ArtworkFace({url}:{url?:string}) { return url?<img src={url} alt="" draggable={false}/>:null; }

function AvPortrait({person,current,items,revision,size='small'}:{person:AvPerson;current:CollectionSummary;items:CollectionSummary[];revision:string;size?:'small'|'large'}) {
  const crop=person.portraitCrop;
  const source=items.find(item=>item.artworkVersions?.[crop?.artworkId??''])??current;
  const url=useArtworkUrls(source,{front:crop?.artworkId},revision,false,true).front;
  const style:CSSProperties={};
  if(url&&crop&&crop.w>0&&crop.h>0){
    style.backgroundImage=`url("${url}")`;
    style.backgroundSize=`${100/crop.w}% ${100/crop.h}%`;
    style.backgroundPosition=`${crop.w<1?crop.x/(1-crop.w)*100:0}% ${crop.h<1?crop.y/(1-crop.h)*100:0}%`;
  }
  return <span className={`av-portrait av-portrait-${size}${url&&crop?' has-image':''}`} style={style} aria-label={`${person.name} 사진`}>{(!url||!crop)&&<span aria-hidden="true">{initials(person.name)}</span>}</span>;
}

function AvWorkCard({item,revision,active,onOpen}:{item:AvItem;revision:string;active:boolean;onOpen(id:string):void}) {
  const front=artworkId(item,'cover')??collectionCover(item);
  const urls=useArtworkUrls(item,{front},revision,false,active);
  const performer=item.av?.people.find(person=>person.role==='performer');
  return <button className="av-work-card" onClick={()=>onOpen(item.id)}>
    <AvCase urls={urls} size={160} alt={`${item.av?.productCode??item.name} DVD 케이스`}/>
    <span className="av-work-code numeric">{item.av?.productCode??item.name}</span>
    <span className="av-work-date numeric">{dateLabel(item.av?.releaseDate??item.releaseDate)}</span>
    <span className="av-work-meta">{item.myScore!=null&&<AvStars score={item.myScore}/>} {performer?.name??'출연자 정보 없음'}</span>
  </button>;
}

function AvShelfTile({item,revision,active,onOpen,order}:{item:AvItem;revision:string;active:boolean;onOpen(id:string):void;order?:number}) {
  const urls=useArtworkUrls(item,{front:artworkId(item,'cover')??collectionCover(item)},revision,false,active);
  return <button className="av-shelf-tile" onClick={()=>onOpen(item.id)}><AvCase urls={urls} size={130} alt={`${item.av?.productCode??item.name} DVD 케이스`}/>{order!==undefined&&<span><em className="numeric">{order}</em></span>}<b className="numeric">{item.av?.productCode??item.name}</b><small className="numeric">{dateLabel(item.av?.releaseDate??item.releaseDate)}</small></button>;
}

function PerformerShelf({person,works,current,items,revision,active,onOpen}:{person:AvPerson;works:AvItem[];current:AvItem;items:AvItem[];revision:string;active:boolean;onOpen(id:string):void}) {
  return <section className="av-performer-shelf" aria-label={`${person.name} 작품`}><header><div className="av-performer-heading"><AvPortrait person={person} current={current} items={items} revision={revision}/><span><b>{person.name}</b>{person.nameJa&&<small lang="ja">{person.nameJa}</small>}</span></div><span className="muted numeric">소장 {works.length}편 <span aria-hidden="true">›</span></span></header><div className="av-shelf-row">{works.map(work=><AvShelfTile key={work.id} item={work} revision={revision} active={active} onOpen={onOpen}/>)}</div></section>;
}

export function AvCollectionList({items,showcase,showcaseOpen,onShowcase,revision,active,view,onView,onOpen,total,filters,sortLabel,onSort,onRating,onReset}:{items:CollectionSummary[];showcase:CollectionSummary[];showcaseOpen:boolean;onShowcase():void;revision:string;active:boolean;view:AvListView;onView(view:AvListView):void;onOpen(id:string):void;total?:number;filters:CollectionFilters;sortLabel:string;onSort():void;onRating():void;onReset():void}) {
  const [performerId,setPerformerId]=useState<string|null>(null),[performerSheet,setPerformerSheet]=useState(false);
  const avItems=items.filter((item):item is AvItem=>item.type==='av');
  const performers=useMemo(()=>{const map=new Map<string,AvPerson>();for(const item of avItems)for(const person of item.av?.people??[])if(person.role==='performer'&&!map.has(person.id))map.set(person.id,person);return [...map.values()].sort((a,b)=>a.order-b.order||a.name.localeCompare(b.name));},[avItems]);
  const visible=performerId?avItems.filter(item=>item.av?.people.some(person=>person.role==='performer'&&person.id===performerId)):avItems;
  const performerWorks=useMemo(()=>{const map=new Map<string,AvItem[]>();for(const item of avItems)for(const person of item.av?.people??[])if(person.role==='performer'){const list=map.get(person.id)??[];if(!list.includes(item))list.push(item);map.set(person.id,list);}return map;},[avItems]);
  const activePerson=performers.find(person=>person.id===performerId);
  return <>
    <section className="collection-showcase-fold av-showcase" aria-label="쇼케이스"><button className="collection-fold" aria-expanded={showcaseOpen} onClick={onShowcase}><h2>쇼케이스{showcase.length>0&&<span className="numeric muted"> {showcase.length}</span>}</h2><ChevronDownIcon aria-hidden="true"/></button>{showcaseOpen&&<div className="collection-shelf">{showcase.map(item=><AvWorkCard key={item.id} item={item as AvItem} revision={revision} active={active} onOpen={onOpen}/>)}</div>}</section>
    <div className="av-list-switch-row"><div className="av-list-switch" role="tablist" aria-label="AV 목록 보기"><button role="tab" aria-selected={view==='works'} onClick={()=>onView('works')}>작품</button><button role="tab" aria-selected={view==='performers'} onClick={()=>onView('performers')}>배우별</button></div>{view==='works'&&<button className={`filter-chip${performerId?' selected':''}`} onClick={()=>setPerformerSheet(true)}>배우{activePerson&&` · ${activePerson.name}`}<ChevronDownIcon aria-hidden="true"/></button>}</div>
    {view==='works'?<>
      <div className="collection-section collection-all av-all"><h2>{performerId?`${activePerson?.name??'배우'}의 작품`:'전체'}{total!=null&&!performerId&&<span className="numeric muted collection-total"> {total.toLocaleString()}</span>}</h2><div className="filter-chips collection-chips" role="group" aria-label="정렬과 필터"><button className="filter-chip" onClick={onSort}><ArrowsUpDownIcon aria-hidden="true"/>{sortLabel}<ChevronDownIcon aria-hidden="true"/></button><button className={`filter-chip ${filters.rating!=='all'?'selected':''}`} onClick={onRating}>{filters.rating==='all'?'내 별점':`★ ${typeof filters.rating==='number'?filters.rating.toFixed(1):'미평가'}`}<ChevronDownIcon aria-hidden="true"/></button>{filters.rating!=='all'&&<button className="filter-chip" onClick={onReset}>초기화</button>}</div></div>
      <div className="av-grid">{visible.map(item=><AvWorkCard key={item.id} item={item} revision={revision} active={active} onOpen={onOpen}/>)}</div>
    </>:<div className="av-performer-list">{performers.map(person=><PerformerShelf key={person.id} person={person} works={performerWorks.get(person.id)??[]} current={avItems[0]??items[0] as AvItem} items={avItems} revision={revision} active={active} onOpen={onOpen}/>)}</div>}
    {performerSheet&&<BottomSheet title="배우" onClose={()=>setPerformerSheet(false)}><div role="radiogroup" aria-label="배우"><button className="sheet-option" role="radio" aria-checked={performerId===null} onClick={()=>{setPerformerId(null);setPerformerSheet(false);}}>전체 배우<span className="radio-dot"/></button>{performers.map(person=><button key={person.id} className="sheet-option" role="radio" aria-checked={performerId===person.id} onClick={()=>{setPerformerId(person.id);setPerformerSheet(false);}}>{person.name}{person.nameJa&&<small lang="ja"> · {person.nameJa}</small>}<span className="radio-dot"/></button>)}</div></BottomSheet>}
  </>;
}

function RelatedShelf({title,items,revision,active,onOpen,series=false}:{title:string;items:AvItem[];revision:string;active:boolean;onOpen(id:string):void;series?:boolean}) {
  if(!items.length)return null;
  return <section className="av-detail-section" aria-label={title}><header><h2>{title}</h2><span className="numeric">{items.length}</span></header><div className="av-shelf-row">{items.map((item,index)=><AvShelfTile key={item.id} item={item} revision={revision} active={active} onOpen={onOpen} order={series?index+1:undefined}/>)}</div></section>;
}

export function AvCollectionDetail({item,items,revision,active,onOpen,personal}:{item:CollectionDetail;items:CollectionSummary[];revision:string;active:boolean;onOpen(id:string):void;personal?:ReactNode}) {
  const [pose,setPose]=useState<DvdPose>('front');
  const front=artworkId(item,'cover')??item.selectedWorkArtworkId,spine=artworkId(item,'spine'),back=artworkId(item,'back');
  const urls=useArtworkUrls(item,{front,spine,back},revision,true,active);
  const avItems=items.filter((candidate):candidate is AvItem=>candidate.type==='av');
  const people=item.av?.people??[];
  const performers=people.filter(person=>person.role==='performer');
  const samePerformer=avItems.filter(candidate=>candidate.id!==item.id&&candidate.av?.people.some(person=>person.role==='performer'&&performers.some(current=>current.id===person.id)));
  const sameSeries=item.av?.series?avItems.filter(candidate=>candidate.id!==item.id&&candidate.av?.series===item.av?.series):[];
  const sameLabel=item.av?.label?avItems.filter(candidate=>candidate.id!==item.id&&candidate.av?.label===item.av?.label):[];
  return <article className="av-mobile-detail" aria-label="AV 상세">
    <section className="av-mobile-hero"><div className="av-mobile-case"><AvCase urls={urls} pose={pose} interactive size={350} alt={`${item.av?.titleJa??item.name} DVD 케이스`} onPoseChange={setPose}/><div className="av-case-stops" role="group" aria-label="케이스 면">{(['front','spine','back'] as DvdPose[]).map(value=><button key={value} aria-pressed={pose===value} onClick={()=>setPose(value)}>{value==='front'?'앞면':value==='spine'?'책등':'뒷면'}</button>)}</div><p className="hint">끌어서 돌리기</p></div>
      <div className="av-mobile-identity"><div className="av-mobile-code"><b className="numeric">{item.av?.productCode??'품번 없음'}</b><span className="muted"> · 모바일 컬렉션</span></div><h1 lang={item.av?.titleJa?'ja':undefined}>{item.av?.titleJa??item.name}</h1>{item.av?.titleJa&&item.name!==item.av.titleJa&&<p className="muted">{item.name}</p>}<div className="av-mobile-facts"><span>발매 <b className="numeric">{dateLabel(item.av?.releaseDate??item.releaseDate)||'미상'}</b></span><span>수록 <b className="numeric">{item.runtimeMinutes??'—'}</b>분</span></div><dl className="av-mobile-meta">{[['메이커',item.av?.maker],['레이블',item.av?.label],['시리즈',item.av?.series]].filter(([,value])=>!!value).map(([label,value])=><div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl>{(item.av?.genres??[]).length>0&&<div className="av-mobile-genres">{item.av?.genres.map(genre=><span key={genre}>{genre}</span>)}</div>}{personal}</div>
    </section>
    <section className="av-mobile-cast" aria-label="출연"><header><h2>출연</h2><span className="numeric">{performers.length}</span></header><div className="av-mobile-cast-row">{people.map(person=><div className="av-mobile-person" key={`${person.role}/${person.id}`}><AvPortrait person={person} current={item} items={avItems} revision={revision} size="large"/><span><b>{person.name}</b>{person.nameJa&&<small lang="ja">{person.nameJa}</small>}<small>{person.role==='director'?'감독':'출연'}</small></span></div>)}</div></section>
    <div className="av-mobile-related"><RelatedShelf title="같은 배우의 다른 작품" items={samePerformer} revision={revision} active={active} onOpen={onOpen}/><RelatedShelf title="같은 시리즈" items={sameSeries} revision={revision} active={active} onOpen={onOpen} series/><RelatedShelf title="같은 레이블" items={sameLabel} revision={revision} active={active} onOpen={onOpen}/></div>
    <details className="av-mobile-more"><summary>자세한 정보</summary><dl>{item.originalTitle&&<div><dt>원제</dt><dd lang="ja">{item.originalTitle}</dd></div>}{item.description&&<div><dt>메모</dt><dd>{item.description}</dd></div>}<div><dt>표지</dt><dd>앞면 · 책등 · 뒷면</dd></div></dl></details>
  </article>;
}
