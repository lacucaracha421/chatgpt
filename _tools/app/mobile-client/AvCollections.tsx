import {PerformerName, usePerformerNames} from "./PerformerName";
import {performerName} from "../src/collections/av/performerName";
import { BusyLabel } from "../src/shared/ui/BusyLabel";
import {useMemo, useRef, useState, type CSSProperties} from 'react';
import {ChevronDownIcon, ChevronRightIcon} from '@heroicons/react/24/outline';
import {CollectionList} from '../src/collections/CollectionList';
import {displayDate, displayDateTime} from '../src/shared/displayDate';
import {StableImage} from '../src/shared/ui/StableImage';
import {useArtworkSet, usePortraitUrl} from './collectionArtwork';
import {usePrivacyMode} from './privacyMode';
import {ShelfTile} from './CollectionShelf';
import type {AvPerson, CollectionDetail, CollectionSummary} from './collectionModel';
import {api} from './transport';
import {normalizeProductCode, readAvLookupRecent, writeAvLookupRecent, type AvLookupRecent} from './avLookup';
import {Button, SectionLabel, Tabs} from './ui';
import {Fold} from './Fold';
import './avCollections.css';

export type AvListView = 'works' | 'performers';
export const AV_LIST_VIEW_KEY = 'lakomics.mobile.avListView';

function initials(value:string) {
  const parts=value.trim().split(/\s+/).filter(Boolean);
  return parts.length>1 ? `${Array.from(parts[0]!)[0]??''}${Array.from(parts[parts.length-1]!)[0]??''}`.toUpperCase() : Array.from(value.trim())[0]??'?';
}

/**
 * A performer's portrait: the StashDB / Commons image the PC published (`portraitImage`), else
 * the crop the PC stored from one of the published covers, else initials. The cover is found
 * among `items` by its artwork id (the list publishes its version). A changed image keeps the
 * shown one until it is decoded; a failed image falls back to the crop. Privacy mode shows
 * initials only and requests nothing, as on the PC.
 */
export function PersonPortrait({person,current,items,revision,size='small',privacy:hide=false}:{person:AvPerson;current:CollectionSummary;items:CollectionSummary[];revision:string;size?:'small'|'large';privacy?:boolean}) {
  const [privateMode]=usePrivacyMode();
  const privacy=hide||privateMode;
  const image=person.portraitImage?.sha256?person.portraitImage:null;
  const portrait=usePortraitUrl(image?.sha256??null,!privacy);
  const imageWanted=!!image&&!portrait.failed;
  const crop=privacy||imageWanted?null:person.portraitCrop;
  const source=items.find(item=>item.artworkVersions?.[crop?.artworkId??''])??current;
  const url=useArtworkSet(source,crop?{front:{id:crop.artworkId,original:false}}:{},revision,!privacy&&!imageWanted).urls.front;
  const label=`${performerName(person).primary} 사진`;
  if(!privacy&&image&&portrait.url)return <span className={`av-portrait av-portrait-${size} has-image`} aria-label={label}>
    <StableImage src={portrait.url} alt="" width={image.width||undefined} height={image.height||undefined} draggable={false}/>
  </span>;
  const style:CSSProperties={};
  if(url&&crop&&crop.w>0&&crop.h>0){
    style.backgroundImage=`url("${url}")`;
    style.backgroundSize=`${100/crop.w}% ${100/crop.h}%`;
    style.backgroundPosition=`${crop.w<1?crop.x/(1-crop.w)*100:0}% ${crop.h<1?crop.y/(1-crop.h)*100:0}%`;
  }
  return <span className={`av-portrait av-portrait-${size}${url&&crop?' has-image':''}`} style={style} aria-label={label}>{(!url||!crop)&&<span aria-hidden="true">{initials(performerName(person).primary)}</span>}</span>;
}

type LookupFeedback = {kind: 'sent'; code: string} | {kind: 'offline' | 'rate' | 'invalid'};

function lookupError(reason: unknown): Exclude<LookupFeedback['kind'], 'sent'> {
  const status = reason && typeof reason === 'object' && 'status' in reason ? (reason as {status?: unknown}).status : undefined;
  if (status === 429) return 'rate';
  if (status === 422) return 'invalid';
  return 'offline';
}

function recentTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '보낸 시간 알 수 없음';
  return displayDateTime(value, new Date(), {withTime: true});
}

export function AvLookupSender({disabled=false,onSent}:{disabled?:boolean;onSent?():void}={}) {
  const [value, setValue] = useState('');
  const [recent, setRecent] = useState<AvLookupRecent[]>(() => readAvLookupRecent());
  const [feedback, setFeedback] = useState<LookupFeedback | null>(null);
  const [sending, setSending] = useState(false);
  const attempt = useRef<{requestId: string; code: string} | null>(null);
  const normalized = normalizeProductCode(value);

  const send = async () => {
    if (!normalized || sending || disabled) {
      if (!normalized) setFeedback({kind: 'invalid'});
      return;
    }
    const code = normalized;
    const current = attempt.current?.code === code ? attempt.current : null;
    const requestId = current?.requestId ?? crypto.randomUUID();
    attempt.current = {requestId, code};
    setSending(true);
    setFeedback(null);
    try {
      await api('/v1/av-lookups', undefined, {requestId, productCode: code, sourceUrl: null}, 'POST');
      const entry = {code, sentAt: new Date().toISOString()};
      const next = [entry, ...recent.filter(item => item.code !== code)].slice(0, 5);
      setRecent(next);
      writeAvLookupRecent(next);
      attempt.current = null;
      setFeedback({kind: 'sent', code});
      onSent?.();
    } catch (reason) {
      setFeedback({kind: lookupError(reason)});
    } finally {
      setSending(false);
    }
  };

  const message = feedback?.kind === 'sent'
    ? `${feedback.code}을 보냈어요. 후보가 준비되면 받은 품번에서 고를 수 있어요.`
    : feedback?.kind === 'rate'
      ? '요청이 많아요. 잠시 후 다시 보내 주세요'
      : feedback?.kind === 'invalid'
        ? '품번이 올바르지 않아요. 예: SSIS-001'
        : feedback?.kind === 'offline'
          ? '오프라인이라 품번을 보내지 못했어요. 연결을 확인하고 다시 시도해 주세요.'
          : '';

  return <section className="av-lookup-sender" aria-label="품번 보내기">
    <div className="av-lookup-heading"><div><h2>품번 보내기</h2></div><span className="numeric muted">최근 {recent.length}/5</span></div>
    <div className="av-lookup-form">
      <label htmlFor="av-product-code">품번</label>
      <div className="av-lookup-controls">
        <input id="av-product-code" value={value} placeholder="예: SSIS-001" autoCapitalize="characters" onChange={event => {
          const next = event.target.value.toUpperCase();
          setValue(next);
          if (attempt.current?.code !== normalizeProductCode(next)) attempt.current = null;
          setFeedback(null);
        }}/>
        <Button type="button" variant="primary" disabled={disabled || !normalized || sending} onClick={() => void send()}><BusyLabel busy={!!(sending)} idle={feedback?.kind === 'offline' || feedback?.kind === 'rate' ? '다시 보내기' : '보내기'}>보내는 중…</BusyLabel></Button>
      </div>
      {normalized && <p className="av-lookup-preview" aria-live="polite">정규화된 품번: <strong className="numeric">{normalized}</strong></p>}
    </div>
    {message && <p className={`av-lookup-feedback is-${feedback?.kind}`} role="status" aria-live="polite">{message}</p>}
    {recent.length > 0 && <ul className="av-lookup-recent" aria-label="최근 보낸 품번">{recent.map(entry => <li key={`${entry.code}-${entry.sentAt}`}><strong className="numeric">{entry.code}</strong><time dateTime={entry.sentAt}>{recentTime(entry.sentAt)}</time></li>)}</ul>}
  </section>;
}

/** 작품 · 배우별: the AV list as works (the shared shelf or grid) or as one shelf per performer. */
export function AvViewTabs({view,onView}:{view:AvListView;onView(view:AvListView):void}) {
  return <Tabs className="av-view-tabs" label="AV 목록 보기" value={view} onChange={onView} tabs={[{value:'works',label:'작품'},{value:'performers',label:'배우별'}]}/>;
}

/** Each work's performers (not directors), first credited first. */
export function performersOf(item:CollectionSummary) {
  return (item.av?.people??[]).filter(person=>person.role==='performer');
}

/**
 * 배우별: one shelf row per performer of the loaded works; a tap on the name opens the
 * performer page, the cases behave as on the works shelf (tap picks, a second tap opens).
 */
export function AvPerformerShelves({items,revision,active,privacy,perRow,picked,onTap,onPerformer}:{items:CollectionSummary[];revision:string;active:boolean;privacy:boolean;perRow:number;picked:string|null;onTap(id:string):void;onPerformer(id:string):void}) {
  const rows=useMemo(()=>{
    const people=new Map<string,{person:AvPerson;works:CollectionSummary[]}>();
    for(const item of items)for(const person of performersOf(item)){
      const row=people.get(person.id)??{person,works:[]};
      if(!row.works.includes(item))row.works.push(item);
      people.set(person.id,row);
    }
    return [...people.values()].sort((a,b)=>a.person.order-b.person.order||a.person.name.localeCompare(b.person.name,'ko'));
  },[items]);
  return <div className="av-performer-list">{rows.map(({person,works})=><section key={person.id} className="av-performer-shelf" aria-label={`${performerName(person).primary} 작품`}>
    <button type="button" className="av-performer-heading" onClick={()=>onPerformer(person.id)}>
      <PersonPortrait person={person} current={works[0]!} items={items} revision={revision}/>
      <span><PerformerName person={person}/></span>
      <span className="muted numeric">{works.length.toLocaleString()}편</span><ChevronRightIcon aria-hidden="true"/>
    </button>
    <CollectionList items={works} view={{layout:'shelf',perRow,grouping:'sort'}} showcase windowRows pickedId={picked} label={`${performerName(person).primary} 작품 선반`} onPick={onTap}
      render={work=><ShelfTile item={work} revision={revision} active={active} privacy={privacy} picked={picked===work.id} onTap={onTap}/>}/>
  </section>)}</div>;
}

/**
 * 출연 · 감독 in the work information: a performer opens the performer page. A performer's
 * work count is shown only while `items` is the whole AV list (`complete`), never a partial count.
 */
export function AvCast({item,items,complete,revision,onPerson}:{item:CollectionDetail;items:CollectionSummary[];complete:boolean;revision:string;onPerson(id:string):void}) {
  const people=item.av?.people??[];
  if(!people.length)return null;
  const count=(person:AvPerson)=>items.filter(work=>performersOf(work).some(other=>other.id===person.id)).length;
  return <section className="work-info" aria-label="출연 · 감독"><SectionLabel title="출연 · 감독"/><div className="tablet-work-people">
    {people.map(person=><Button key={`${person.role}/${person.id}`} variant="ghost" className="tablet-work-person" disabled={person.role!=='performer'} onClick={()=>onPerson(person.id)}>
      <PersonPortrait person={person} current={item} items={items} revision={revision}/>
      <span><PerformerName person={person}/><small>{person.role==='director'?'감독':[complete?`내 라이브러리 ${count(person).toLocaleString()}편`:null].filter(Boolean).join(' · ')}</small>{person.creditName && person.creditName !== performerName(person).primary && person.creditName !== performerName(person).secondary && <small>{person.creditName}</small>}</span>
    </Button>)}
  </div></section>;
}

/** 관련 작품, as on the PC: the performers' other works, the same series and label, from the loaded works. */
export function AvRelatedWorks({item,items,onOpen}:{item:CollectionDetail;items:CollectionSummary[];onOpen(id:string):void}) {
  const [open,setOpen]=useState(false);
  const people=usePerformerNames(performersOf(item), open);
  const others=items.filter(work=>work.type==='av'&&work.id!==item.id);
  const groups=[
    ...people.map(person=>({name:`${performerName(person).primary} · 다른 작품`,works:others.filter(work=>performersOf(work).some(other=>other.id===person.id))})),
    ...(item.av?.series?[{name:'같은 시리즈',works:others.filter(work=>work.av?.series===item.av?.series)}]:[]),
    ...(item.av?.label?[{name:'같은 레이블',works:others.filter(work=>work.av?.label===item.av?.label)}]:[]),
  ].filter(group=>group.works.length>0);
  if(!groups.length)return null;
  return <div className="tablet-work-related"><button type="button" className="tablet-work-related__toggle" aria-expanded={open} onClick={()=>setOpen(value=>!value)}>관련 작품<ChevronDownIcon aria-hidden="true"/></button><Fold open={open}>{groups.map(group=><section key={group.name} aria-label={group.name}><SectionLabel title={group.name}/>
    {group.works.map(work=><Button key={work.id} variant="quiet" onClick={()=>onOpen(work.id)}>{[work.av?.productCode??work.name,displayDate(work.av?.releaseDate??work.releaseDate)].filter(Boolean).join(' · ')}</Button>)}
  </section>)}</Fold></div>;
}
