import {performerName} from "../src/collections/av/performerName";
import {loadInboxJacket} from './avInboxThumbnail';
import {useEffect, useId, useState, type CSSProperties} from 'react';
import {Select} from '../src/shared/ui/Select';
import {StableImage} from '../src/shared/ui/StableImage';
import {BusyLabel} from '../src/shared/ui/BusyLabel';
import {BottomSheet} from './BottomSheet';
import {Badge, Button, Checkbox, Field, SectionLabel, TextInput} from './ui';
import {usePrivacyMode} from './privacyMode';
import {useArtworkSet} from './collectionArtwork';
import {errorText} from './transport';
import {normalizeProductCode} from './avLookup';
import type {CollectionSummary} from './collectionModel';
import {sameAvValue} from './avEditModel';
import {createInboxPlan, initialChoices, inboxWorks, inboxPeople, inboxMatches, refreshedChoices, inboxRecheckChanges, readInboxPlans, surfaceSlot, type InboxChoices, type PersonChoice} from './avInboxApply';
import {candidateHasSurface, SURFACES, SURFACE_LABELS, type InboxAuthority, type InboxCandidate, type InboxDetail, type InboxWork, type Surface} from './avInbox';

export function useInboxJacket(id:string,enabled:boolean,version?:string){
  const [value,setValue]=useState<{id:string;url:string}|null>(null);
  useEffect(()=>{if(!enabled)return;const abort=new AbortController();void loadInboxJacket(id,abort.signal).then(url=>{if(!abort.signal.aborted)setValue({id,url});}).catch(()=>{});return()=>abort.abort();},[id,enabled,version]);
  return enabled&&value?.id===id?value.url:null;
}
export function CandidateThumb({candidate,surface,url}:{candidate:InboxCandidate;surface:Surface;url:string|null}){
  if(!url||!candidateHasSurface(candidate,surface))return <span className="av-inbox-thumb" aria-label={url?'후보 없음':'표지 숨김'}>—</span>;
  const {x1,x2,isWrap}=candidate.defaultSplit,w=candidate.jacketWidth,h=candidate.jacketHeight;
  const x=surface==='front'?(isWrap?x2:0):surface==='back'?0:x1;
  const width=surface==='front'?w-x:surface==='back'?x1:x2-x1;
  return <span className="av-inbox-thumb" style={{aspectRatio:`${width}/${h}`}}><StableImage src={url} alt={`${SURFACE_LABELS[surface]} 후보`} draggable={false} style={{width:`${w/width*100}%`,maxWidth:'none',height:'100%',position:'absolute',left:`-${x/width*100}%`}}/></span>;
}
const INFO=[{key:'titleJa',label:'원제'},{key:'releaseDate',label:'발매일'},{key:'maker',label:'제작사'},{key:'label',label:'레이블'},{key:'series',label:'시리즈'},{key:'genres',label:'장르'}] as const;
const text=(v:unknown)=>Array.isArray(v)?v.length?v.join(' · '):'—':typeof v==='string'&&v?v:'—';
function matchPerson(authority:InboxAuthority,p:PersonChoice){
  if(p.action==='link'&&p.personId)return authority.people.find(person=>person.personId===p.personId&&authority.works.some(work=>work.avCredits.some(credit=>credit.personId===person.personId&&credit.role===p.role)));
  const matches=authority.people.filter(person=>person.nameJa===p.nameJa&&authority.works.some(work=>work.avCredits.some(credit=>credit.personId===person.personId&&credit.role===p.role)));
  return matches.length===1?matches[0]:undefined;
}
function withPeople(choices:InboxChoices,authority:InboxAuthority,work:InboxWork|null):InboxChoices{
  return {...choices,people:choices.people.map(p=>{if(p.action==='skip')return p;const known=authority.people.find(person=>person.nameJa===p.nameJa&&work?.avCredits.some(credit=>credit.personId===person.personId&&credit.role===p.role))??matchPerson(authority,p);return known?{...p,action:'link',personId:known.personId,displayName:known.displayName}:p.action==='link'?{...p,action:'new',personId:null}:p;})};
}
export function AvInboxChooser({detail,authority,items,disabled,onClose,onLater,onApplied,onReject}:{detail:InboxDetail;authority:InboxAuthority;items:CollectionSummary[];disabled:boolean;onClose():void;onLater():void;onApplied():void;onReject():void}){
  const linkLabelId=useId();
  const peopleAuthority={...authority,works:inboxWorks(authority,detail.inbox.id),people:inboxPeople(authority,detail.inbox.id)};
  const peopleForRole=(role:PersonChoice['role'])=>peopleAuthority.people.filter(person=>peopleAuthority.works.some(work=>work.avCredits.some(credit=>credit.personId===person.personId&&credit.role===role)));
  const activePlan=readInboxPlans().find(p=>p.id===detail.inbox.id&&p.state!=='done');
  const matches=inboxMatches(detail,authority);
  const previous=readInboxPlans().find(p=>p.id===detail.inbox.id&&p.state==='blocked');
  const live=inboxWorks(authority,detail.inbox.id);
  const [target,setTarget]=useState<string|null>(()=>previous?(previous.isNew&&live.some(w=>w.workId===previous.workId)?previous.workId:previous.choices.workId??'new'):matches.length===1?matches[0]!.workId:matches.length===0?'new':null);
  const base=live.find(w=>w.workId===target)??null;
  const [choices,setChoices]=useState<InboxChoices>(()=>withPeople(refreshedChoices(detail,base,previous),peopleAuthority,base));
  const recheckChanges=previous?inboxRecheckChanges(detail,base,previous):[];
  const [other,setOther]=useState(false),[busy,setBusy]=useState(false),[error,setError]=useState('');
  const [privacy]=usePrivacyMode();const c=detail.candidate!;const jacket=useInboxJacket(detail.inbox.id,!privacy,`${detail.inbox.normalizedCode}/${detail.inbox.fetchedAt??''}`);
  const currentItem=items.find(item=>item.id===base?.workId)??{id:base?.workId??'',name:base?.name??'',type:'av' as const,showcase:false};
  const versions=Object.fromEntries(authority.artworks.filter(a=>a.workId===base?.workId).map(a=>{const receipt=a as typeof a&{original?:{sha256:string};thumbnail?:{sha256:string}|null};return [a.artworkId,{original:receipt.original?.sha256,thumbnail:receipt.thumbnail?.sha256??null}];}));
  const artworkItem={...currentItem,artworkVersions:{...currentItem.artworkVersions,...versions}};
  const currentCovers=useArtworkSet(artworkItem,Object.fromEntries(SURFACES.map(s=>[s,{id:base?.selection[surfaceSlot(s)]??null,original:false}])),String(base?.entityRevision??''),!!base&&!privacy).urls;
  const changeTarget=(id:string)=>{const work=live.find(w=>w.workId===id)??null;setTarget(id);setChoices(withPeople(initialChoices(detail,work),peopleAuthority,work));setError('');};
  const covers=SURFACES.filter(s=>choices.surfaces[s]==='candidate'||choices.surfaces[s]==='clear'&&!!base?.selection[surfaceSlot(s)]).length;
  const info=Object.keys(choices.fields).length+choices.people.filter(p=>p.action!=='skip'&&!base?.avCredits.some(credit=>credit.personId===p.personId&&credit.role===p.role)).length;
  const mismatch=base?.details.av?.productCode&&String(base.details.av.productCode).trim()&&detail.inbox.normalizedCode!==normalizeProductCode(String(base.details.av.productCode));
  const apply=()=>{if(disabled||busy||target===null)return;setBusy(true);try{createInboxPlan(detail,authority,{...choices,workId:target==='new'?null:target});onApplied();}catch(reason){setError(errorText(reason));}finally{setBusy(false);}};
  const changePerson=(index:number,changes:Partial<PersonChoice>)=>setChoices(current=>({...current,people:current.people.map((p,at)=>at===index?{...p,...changes}:p)}));
  const jacketStyle:CSSProperties={aspectRatio:`${c.jacketWidth}/${c.jacketHeight}`};
  return <BottomSheet tall stacked title={base?'후보 확인':'새 AV 컬렉션으로 만들기'} onClose={onClose}><div className="av-inbox-chooser">
    {previous&&<p role="status">다시 확인했어요 · {recheckChanges.length?`${recheckChanges.join(' · ')} 바뀜`:'바뀐 항목 없음'}. 바뀐 표지는 유지하고, 비어 있는 정보만 선택했어요. 바뀌지 않은 선택은 그대로예요.</p>}
    <header><b className="numeric">{detail.inbox.normalizedCode??detail.inbox.productCode}</b><small>LibreDMM</small></header>
    <section><SectionLabel title="적용할 곳"/>
      {matches.length===1&&!other&&target!=='new'&&<div className="av-inbox-target"><b>{base?.name??matches[0]!.name}</b><small>기존 컬렉션에 후보 추가</small><Button onClick={()=>setOther(true)}>다른 컬렉션</Button></div>}
      {matches.length>1&&!other&&<div role="radiogroup" aria-label="후보를 넣을 곳"><p>같은 품번의 컬렉션이 {matches.length}개 있어요</p>{matches.map(m=><Button key={m.workId} role="radio" aria-checked={target===m.workId} onClick={()=>changeTarget(m.workId)}>{m.name}</Button>)}<Button role="radio" aria-checked={target==='new'} onClick={()=>changeTarget('new')}>새 AV 컬렉션으로 만들기</Button></div>}
      {target==='new'&&<><Field label="새 컬렉션 이름"><TextInput value={choices.name} onChange={e=>setChoices(current=>({...current,name:e.target.value}))}/></Field><Button onClick={()=>setChoices(current=>({...current,name:String(c.fields.titleJa||detail.inbox.normalizedCode)}))}>원제로 채우기</Button></>}
      {matches.length===0&&!other&&<div className="av-inbox-target"><small>맞는 기존 컬렉션 없음</small><Button variant="ghost" onClick={()=>setOther(true)}>기존 컬렉션에 연결…</Button></div>}
      {other&&<Select label="적용할 컬렉션" value={target??''} onChange={e=>changeTarget(e.target.value)}><option value="" disabled>넣을 곳을 고르세요</option><option value="new">새 AV 컬렉션으로 만들기</option>{live.map(w=><option key={w.workId} value={w.workId}>{w.name}</option>)}</Select>}
      {mismatch&&<p role="alert">품번이 다른 컬렉션</p>}
    </section>
    <section><SectionLabel title="표지"/><div className="av-inbox-jacket" style={jacketStyle}>
      {jacket?<StableImage src={jacket} alt="후보 펼친 표지" draggable={false}/>:<span>{privacy?'표지 숨김':'—'}</span>}
      {c.defaultSplit.isWrap&&<>{[c.defaultSplit.x1,c.defaultSplit.x2].map((x,i)=><i className="av-inbox-cut" key={i} style={{left:`${x/c.jacketWidth*100}%`}}/>)}
        <span className="av-inbox-region" style={{left:0,width:`${c.defaultSplit.x1/c.jacketWidth*100}%`}}>뒤표지</span><span className="av-inbox-region" style={{left:`${c.defaultSplit.x1/c.jacketWidth*100}%`,width:`${(c.defaultSplit.x2-c.defaultSplit.x1)/c.jacketWidth*100}%`}}>책등</span><span className="av-inbox-region" style={{left:`${c.defaultSplit.x2/c.jacketWidth*100}%`,right:0}}>앞표지</span></>}
      {!c.defaultSplit.isWrap&&<span className="av-inbox-region">앞표지</span>}
    </div><small>원본 {c.jacketWidth} × {c.jacketHeight} · 서버 자동 나눔</small>
      {target===null?<p>넣을 곳을 고르면 지금 표지·정보와 나란히 보여요</p>:SURFACES.map(s=>{const available=candidateHasSurface(c,s),id=base?.selection[surfaceSlot(s)],manual=!!id&&authority.artworks.some(a=>a.artworkId===id&&a.provider==='local-manual');return <div className="av-inbox-surface" key={s}><b>{SURFACE_LABELS[s]}</b><div className="av-inbox-comparison"><div><small>지금</small>{!privacy&&currentCovers[s]?<span className="av-inbox-thumb"><StableImage src={currentCovers[s]!} alt={`지금 ${SURFACE_LABELS[s]}`}/></span>:<span className="av-inbox-thumb">—</span>}{manual&&<Badge>직접 고름</Badge>}</div><span>→</span><div><small>후보</small>{available?<CandidateThumb candidate={c} surface={s} url={jacket}/>:<span>후보 없음</span>}</div></div><div className="av-inbox-surface-actions" role="group" aria-label={`${SURFACE_LABELS[s]} 선택`}>{(['candidate','keep','clear'] as const).filter(action=>action!=='keep'||!!base).map(action=><Button key={action} aria-pressed={choices.surfaces[s]===action} disabled={disabled||action==='candidate'&&!available} onClick={()=>setChoices(current=>({...current,surfaces:{...current.surfaces,[s]:action}}))}>{action==='candidate'?'후보 사용':action==='keep'?'유지':'비우기'}</Button>)}</div></div>;})}
    </section>
    {target!==null&&<section><SectionLabel title="정보"/>{INFO.map(({key,label})=>{const value=c.fields[key],old=base?.details.av?.[key]??(key==='genres'?[]:null),empty=value==null||value===''||Array.isArray(value)&&!value.length,same=sameAvValue(value,old),checked=key in choices.fields;return <div className="av-inbox-diff" key={key}><Checkbox label="" aria-label={`${label} 적용`} checked={checked} disabled={disabled||empty||same} onChange={e=>setChoices(current=>{const fields={...current.fields};if(e.target.checked)fields[key]=value;else delete fields[key];return {...current,fields};})}/><b>{label}</b><div><span>{empty?'후보 없음':text(value)}</span>{base&&<small>지금 {text(old)} {!empty&&<Badge>{same?'같음':text(old)!=='—'?'다름':'빈 칸'}</Badge>}</small>}</div></div>;})}
      {(['performer','director'] as const).map(role=><section key={role}><SectionLabel title={role==='performer'?'출연':'감독'}/>{choices.people.map((p,index)=>{if(p.role!==role)return null;const known=matchPerson(peopleAuthority,p);const selected=p.action==='link'?peopleForRole(role).find(person=>person.personId===p.personId):undefined;const display=selected?performerName(selected):null;const linked=known&&base?.avCredits.some(credit=>credit.personId===known.personId&&credit.role===role);return <div className="av-inbox-person" key={`${p.role}/${p.nameJa}`}>{linked?<><b>{performerName(known).primary}</b><small lang="ja">{p.nameJa} · 이미 연결됨</small></>:<><Checkbox label="" aria-label={`${p.nameJa} 적용`} checked={p.action!=='skip'} disabled={disabled} onChange={e=>changePerson(index,{action:e.target.checked?known?'link':'new':'skip',personId:known?.personId??null})}/><span className="av-inbox-person-initial" aria-hidden="true">{[...p.displayName][0]??[...p.nameJa][0]}</span><div className="av-inbox-person-name"><TextInput aria-label={`${p.nameJa} 한국어 이름`} value={display?.primary ?? p.displayName} maxLength={120} disabled={disabled||p.action!=='new'} onChange={e=>changePerson(index,{displayName:e.target.value})}/><small lang="ja">{display ? display.secondary : p.nameJa}</small></div><div className="av-inbox-person-link"><span className="sr-only" id={`${linkLabelId}-${index}`}>{p.nameJa} 인물 연결</span><Select label="" aria-labelledby={`${linkLabelId}-${index}`} className="ui-text-input" value={p.action==='link'?p.personId??'':'new'} disabled={disabled||p.action==='skip'} onChange={e=>{const person=peopleForRole(role).find(v=>v.personId===e.target.value);changePerson(index,{action:person?'link':'new',personId:person?.personId??null,displayName:person?.displayName??p.nameJa});}}><option value="new">새 인물</option>{peopleForRole(role).map(person=><option key={person.personId} value={person.personId}>{performerName(person).primary}{performerName(person).secondary ? ` · ${performerName(person).secondary}` : ""}에 연결</option>)}</Select></div></>}</div>;})}</section>)}
    </section>}
    {error&&<p role="alert">{error}</p>}
    <footer className="av-inbox-footer"><Button variant="danger" disabled={disabled||busy||!!activePlan} onClick={onReject}>거절</Button><small>{target===null?'넣을 곳을 고르세요':`표지 ${covers}면 · 정보 ${info}개 바뀜`}</small><Button disabled={busy||disabled} onClick={onLater}>나중에</Button><Button variant="primary" disabled={disabled||busy||target===null||!!mismatch||choices.people.some(p=>p.action==='new'&&!p.displayName.trim())} onClick={apply}><BusyLabel busy={busy} idle="적용">준비하는 중</BusyLabel></Button></footer>
  </div></BottomSheet>;
}
