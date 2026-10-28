import {performerName} from "../src/collections/av/performerName";
import {displayAvGenres, hiddenAvGenreCount} from '../src/collections/avGenreNames';
import {AvCoverStage, AvSurfaceOptionFace, type SurfaceControl} from '../src/collections/avReview/AvCoverStage';
import {AvDestination, AvPickList, NEW_DESTINATION, type DestinationRow} from '../src/collections/avReview/AvDestination';
import {AvInfoSection, INFO_KEYS, type AvInfoModel, type InfoKey} from '../src/collections/avReview/AvInfoSection';
import {coversChanged, initialSplit, resolveChoices, SURFACE_NAMES, type Split} from '../src/collections/avReview/avReviewModel';
import '../src/collections/avReview/avReview.css';
import {ArrowTopRightOnSquareIcon, ChevronDownIcon} from '@heroicons/react/24/outline';
import {useEffect, useState} from 'react';
import {useMotionSurface} from '../src/shared/ui/useMotionSurface';
import {BusyLabel} from '../src/shared/ui/BusyLabel';
import {displayTime} from '../src/shared/displayDate';
import {BottomSheet} from './BottomSheet';
import {Button, IconButton, TextInput} from './ui';
import {usePrivacyMode} from './privacyMode';
import {useArtworkSet} from './collectionArtwork';
import {api, errorText, native} from './transport';
import {normalizeProductCode} from './avLookup';
import type {CollectionSummary} from './collectionModel';
import type {AvDetailFields} from './avEditModel';
import {createInboxPlan, defaultInboxPeople, matchInboxPerson, initialChoices, inboxWorks, inboxPeople, inboxMatches, refreshedChoices, inboxRecheckChanges, readInboxPlans, surfaceSlot, type InboxChoices, type PersonChoice} from './avInboxApply';
import {loadInboxJacket} from './avInboxThumbnail';
import {SURFACES, inboxPath, selectInboxJacket, jacketPreview, type InboxCandidate, type InboxAuthority, type InboxDetail, type InboxWork, type Surface} from './avInboxModel';

export function useInboxJacket(id:string,enabled:boolean,version?:string){
  const [value,setValue]=useState<{id:string;url:string}|null>(null);
  useEffect(()=>{if(!enabled)return;const abort=new AbortController();void loadInboxJacket(id,abort.signal).then(url=>{if(!abort.signal.aborted)setValue({id,url});}).catch(()=>{});return()=>abort.abort();},[id,enabled,version]);
  return enabled&&value?.id===id?value.url:null;
}
/** The DVD cover a borrowed spine is cut from, for the 책등 choice's picture. */
function useInboxSpineSource(id:string,enabled:boolean,version?:string){
  const [value,setValue]=useState<{id:string;url:string}|null>(null);
  useEffect(()=>{if(!enabled)return;const abort=new AbortController();void jacketPreview(id,abort.signal,'spine-source').then(url=>{if(!abort.signal.aborted)setValue({id,url});}).catch(()=>{});return()=>abort.abort();},[id,enabled,version]);
  return enabled&&value?.id===id?value.url:null;
}
/** The review's field names against the candidate's. */
const FIELD_KEYS:Record<InfoKey,'titleJa'|'releaseDate'|'maker'|'label'|'series'>={title_ja:'titleJa',release_date:'releaseDate',maker:'maker',label:'label',series:'series'};
const asText=(value:unknown)=>typeof value==='string'&&value.trim()?value:null;
const withPeople=defaultInboxPeople;
const matchPerson=matchInboxPerson;

/** One surface label: it opens the choices in a bottom sheet (the PC opens a menu). */
function SurfaceSheet({surface,face,ariaLabel,value,options,disabled,onChoose}:SurfaceControl&{disabled:boolean;onChoose(surface:Surface,value:SurfaceControl['value']):void}){
  const [open,setOpen]=useState(false);
  return <>
    <button type="button" className="av-cap" aria-label={ariaLabel} aria-haspopup="dialog" disabled={disabled} onClick={()=>setOpen(true)}>{face}</button>
    {open&&<BottomSheet title={SURFACE_NAMES[surface]} onClose={()=>setOpen(false)}>
      <div className="av-sheet-options" role="radiogroup" aria-label={SURFACE_NAMES[surface]}>
        {options.map(option=><button key={option.value} type="button" role="radio" aria-checked={option.value===value} className={`av-cap-menu__item${option.value===value?' is-current':''}`} onClick={()=>{onChoose(surface,option.value);setOpen(false);}}><AvSurfaceOptionFace option={option}/></button>)}
      </div>
    </BottomSheet>}
  </>;
}

export function AvInboxChooser({detail,authority,items,disabled,onClose,onLater,onApplied,onReject}:{detail:InboxDetail;authority:InboxAuthority;items:CollectionSummary[];disabled:boolean;onClose():void;onLater():void;onApplied():void;onReject():void}){
  const peopleAuthority={...authority,works:inboxWorks(authority,detail.inbox.id),people:inboxPeople(authority,detail.inbox.id)};
  const peopleForRole=(role:PersonChoice['role'])=>peopleAuthority.people.filter(person=>peopleAuthority.works.some(work=>work.avCredits.some(credit=>credit.personId===person.personId&&credit.role===role)));
  const activePlan=readInboxPlans().find(p=>p.id===detail.inbox.id&&p.state!=='done');
  const matches=inboxMatches(detail,authority);
  const previous=readInboxPlans().find(p=>p.id===detail.inbox.id&&p.state==='blocked');
  const live=inboxWorks(authority,detail.inbox.id);
  const [selectedJacket,setSelectedJacket]=useState<{candidate:InboxCandidate;url:string;spineUrl:string|null}|null>(null);
  const [pendingJacket,setPendingJacket]=useState<typeof selectedJacket>(null);
  const [switchingJacket,setSwitchingJacket]=useState(false);
  const alternativesRef=useMotionSurface("menu");
  const [jacketsOpen,setJacketsOpen]=useState(false);
  const [jacketImages,setJacketImages]=useState<Record<string,string>>({});
  const c=selectedJacket?.candidate??detail.candidate!;
  const [target,setTarget]=useState<string|null>(()=>previous?(previous.isNew&&live.some(w=>w.workId===previous.workId)?previous.workId:previous.choices.workId??NEW_DESTINATION):matches.length===1?matches[0]!.workId:matches.length===0?NEW_DESTINATION:null);
  const base=live.find(w=>w.workId===target)??null;
  const [choices,setChoices]=useState<InboxChoices>(()=>withPeople(refreshedChoices(detail,base,previous),peopleAuthority,base));
  const [split,setSplit]=useState<Split>(()=>choices.split??initialSplit(c.defaultSplit,c.jacketWidth));
  const candidateGenres=(Array.isArray(c.fields.genres)?c.fields.genres:[]) as string[];
  const visibleGenres=displayAvGenres(candidateGenres);
  const baseGenres=(base?.details.av?.genres??[]) as string[];
  const [picked,setPicked]=useState<Set<string>>(()=>new Set(visibleGenres.map(g=>g.original).filter(g=>((choices.fields.genres??[]) as string[]).includes(g)&&!baseGenres.includes(g))));
  const recheckChanges=previous?inboxRecheckChanges(detail,base,previous):[];
  const [details,setDetails]=useState(false),[otherOpen,setOtherOpen]=useState(false),[otherQuery,setOtherQuery]=useState(''),[linkIndex,setLinkIndex]=useState<number|null>(null),[linkQuery,setLinkQuery]=useState('');
  const [busy,setBusy]=useState(false),[error,setError]=useState('');
  const [privacy]=usePrivacyMode();const jacket=useInboxJacket(detail.inbox.id,!privacy,`${detail.inbox.normalizedCode}/${detail.inbox.fetchedAt??''}`);
  const spineSourceUrl=useInboxSpineSource(detail.inbox.id,!privacy&&!!c.spineSource,`${detail.inbox.normalizedCode}/${detail.inbox.fetchedAt??''}`);
  useEffect(()=>{
    if(!jacketsOpen||privacy||!detail.candidate?.jackets?.length)return;
    const abort=new AbortController();
    void(async()=>{for(const image of detail.candidate!.jackets!){
      if(abort.signal.aborted)return;
      const url=await jacketPreview(detail.inbox.id,abort.signal,'jacket',image.key);
      if(!abort.signal.aborted)setJacketImages(images=>({...images,[image.key]:url}));
    }})().catch(reason=>{if(!abort.signal.aborted)setError(errorText(reason));});
    return()=>abort.abort();
  },[jacketsOpen,privacy,detail]);
  useEffect(()=>{if(privacy&&pendingJacket)finishJacket(pendingJacket);},[privacy,pendingJacket]);
  function finishJacket(next:NonNullable<typeof selectedJacket>){
    setSelectedJacket(next);setSplit(initialSplit(next.candidate.defaultSplit,next.candidate.jacketWidth));
    setPendingJacket(null);setSwitchingJacket(false);
  }
  async function chooseJacket(key:string){
    if(disabled||busy||switchingJacket||key===(c.jacketKey??c.jackets?.find(j=>j.chosen)?.key))return;
    setSwitchingJacket(true);setError('');
    try{
      const candidate=selectInboxJacket(c,key),signal=new AbortController().signal;
      const url=jacketImages[key]??await jacketPreview(detail.inbox.id,signal,'jacket',key);
      const spineUrl=candidate.spineSource?await jacketPreview(detail.inbox.id,signal,'spine-source',key):null;
      const next={candidate,url,spineUrl};if(privacy)finishJacket(next);else setPendingJacket(next);
    }catch(reason){setSwitchingJacket(false);setError(errorText(reason));}
  }
  async function retry(){
    if(disabled||busy||switchingJacket||activePlan)return;
    setBusy(true);setError('');
    try{await api(`${inboxPath(detail.inbox.id)}/retry`,undefined,{},'POST');onClose();}
    catch(reason){setError(errorText(reason));}finally{setBusy(false);}
  }
  const currentItem=items.find(item=>item.id===base?.workId)??{id:base?.workId??'',name:base?.name??'',type:'av' as const,showcase:false};
  const versions=Object.fromEntries(authority.artworks.filter(a=>a.workId===base?.workId).map(a=>{const receipt=a as typeof a&{original?:{sha256:string};thumbnail?:{sha256:string}|null};return [a.artworkId,{original:receipt.original?.sha256,thumbnail:receipt.thumbnail?.sha256??null}];}));
  const artworkItem={...currentItem,artworkVersions:{...currentItem.artworkVersions,...versions}};
  const currentCovers=useArtworkSet(artworkItem,Object.fromEntries(SURFACES.map(s=>[s,{id:base?.selection[surfaceSlot(s)]??null,original:false}])),String(base?.entityRevision??''),!!base&&!privacy).urls;
  const changeTarget=(id:string)=>{
    const work=live.find(w=>w.workId===id)??null;const next=withPeople(initialChoices(detail,work),peopleAuthority,work);
    setTarget(id);setChoices({...next,name:choices.name});setError('');
    setPicked(new Set(visibleGenres.map(g=>g.original).filter(g=>((next.fields.genres??[]) as string[]).includes(g))));
  };
  const hasCurrent=Object.fromEntries(SURFACES.map(s=>[s,!!base?.selection[surfaceSlot(s)]])) as Record<Surface,boolean>;
  const resolved=resolveChoices(choices.surfaces,c.defaultSplit,split,c.jacketWidth,hasCurrent);
  const covers=coversChanged(resolved,hasCurrent);
  const info=Object.keys(choices.fields).length+choices.people.filter(p=>p.action!=='skip'&&!base?.avCredits.some(credit=>credit.personId===p.personId&&credit.role===p.role)).length;
  const mismatch=!!(base?.details.av?.productCode&&String(base.details.av.productCode).trim()&&detail.inbox.normalizedCode!==normalizeProductCode(String(base.details.av.productCode)));
  const isNew=target===NEW_DESTINATION;
  const apply=()=>{if(disabled||busy||switchingJacket||target===null)return;setBusy(true);try{createInboxPlan(detail,authority,{...choices,surfaces:resolved,split,...(c.jacketKey?{jacketKey:c.jacketKey}:{}),workId:isNew?null:target});onApplied();}catch(reason){setError(errorText(reason));}finally{setBusy(false);}};
  const changePerson=(index:number,changes:Partial<PersonChoice>)=>setChoices(current=>({...current,people:current.people.map((p,at)=>at===index?{...p,...changes}:p)}));
  const toggleGenre=(original:string)=>{
    const next=new Set(picked);if(next.has(original))next.delete(original);else next.add(original);setPicked(next);
    setChoices(current=>{const fields={...current.fields};if(next.size)fields.genres=[...baseGenres,...[...next].filter(g=>!baseGenres.includes(g))];else delete fields.genres;return {...current,fields};});
  };
  const code=detail.inbox.normalizedCode??detail.inbox.productCode;
  const sourceUrl=/^https?:\/\//.test(detail.inbox.sourceUrl??'')?detail.inbox.sourceUrl!:null;

  const year=(work:InboxWork)=>String(work.details.av?.releaseDate??'').slice(0,4);
  const rowOf=(work:InboxWork|undefined,id:string,name:string):DestinationRow=>{
    const count=work?SURFACES.filter(s=>work.selection[surfaceSlot(s)]).length:null;
    return {id,name,meta:[work?year(work):'',count!=null?`표지 ${count}면`:''].filter(Boolean).join(' · ')||null,thumbUrl:id===target?currentCovers.front??null:null,warning:id===target&&mismatch?'품번이 다른 컬렉션':null};
  };
  const rows:DestinationRow[]=matches.map(m=>rowOf(live.find(w=>w.workId===m.workId),m.workId,base?.workId===m.workId?base.name:m.name));
  if(base&&!rows.some(row=>row.id===base.workId))rows.push(rowOf(base,base.workId,base.name));

  const model:AvInfoModel={
    isNew:!base,
    fields:INFO_KEYS.map(key=>{const current=asText(base?.details.av?.[FIELD_KEYS[key]]);return {key,candidate:asText(c.fields[FIELD_KEYS[key]]),current,checked:FIELD_KEYS[key] in choices.fields};}),
    people:choices.people.map(p=>{
      const known=matchPerson(peopleAuthority,p);const linked=!!known&&!!base?.avCredits.some(credit=>credit.personId===known.personId&&credit.role===p.role);
      const selected=p.action==='link'?peopleForRole(p.role).find(person=>person.personId===p.personId):undefined;
      const names=linked&&known?performerName(known):selected?performerName(selected):null;
      return {id:p.nameJa,nameJa:p.nameJa,primary:names?.primary||p.displayName||p.nameJa,secondary:names?.secondary||null,linked,newPerson:p.action==='new',selected:p.action!=='skip'};
    }),
    genres:visibleGenres.map(g=>({original:g.original,name:g.name,selected:picked.has(g.original)})),
    currentGenres:displayAvGenres(baseGenres).map(g=>g.name),
    hiddenGenres:hiddenAvGenreCount(candidateGenres),
  };
  const summary=target===null?'넣을 곳을 고르세요':`표지 ${covers}면 · 정보 ${info}개`;
  const otherItems=live.filter(w=>!otherQuery.trim()||w.name.toLowerCase().includes(otherQuery.trim().toLowerCase())).slice(0,50).map(w=>({id:w.workId,primary:w.name,secondary:null,thumbUrl:null}));
  const linkPerson=linkIndex===null?null:choices.people[linkIndex]??null;
  const linkResults=linkPerson?peopleForRole(linkPerson.role).filter(person=>{const needle=linkQuery.trim().toLowerCase();const names=performerName(person);return !needle||`${names.primary} ${names.secondary} ${person.nameJa??''}`.toLowerCase().includes(needle);}).map(person=>({id:person.personId,primary:performerName(person).primary,secondary:performerName(person).secondary||null})):[];
  const notes=Object.fromEntries(SURFACES.filter(s=>{const id=base?.selection[surfaceSlot(s)];return !!id&&authority.artworks.some(a=>a.artworkId===id&&a.provider==='local-manual');}).map(s=>[s,'직접 고름'])) as Partial<Record<Surface,string>>;
  const time=detail.inbox.fetchedAt?displayTime(detail.inbox.fetchedAt):'';
  return <BottomSheet tall stacked title={`AV 후보 ${code}`} onClose={onClose}
    heading={<span className="av-review__sheet-title">{code}<span className="av-review__source">LibreDMM{time&&<> · <span className="numeric">{time}</span></>}</span></span>}
    headerActions={sourceUrl?<IconButton label="LibreDMM 원본 페이지 열기" icon={ArrowTopRightOnSquareIcon} onClick={()=>{void native('openExternal',{url:sourceUrl}).catch(()=>{});}}/>:undefined}>
    <div className="av-review av-review--sheet">
      {previous&&<p className="av-review__stale" role="status">다시 확인함 · {recheckChanges.length?`${recheckChanges.join(' · ')} 바뀜`:'바뀐 항목 없음'}</p>}
      <div style={{position:'relative'}}>
        {[{candidate:c,url:selectedJacket?.url??jacket,spineUrl:selectedJacket?.spineUrl??spineSourceUrl},...(pendingJacket?[pendingJacket]:[])].map(image=>{
          const pending=image===pendingJacket,source=image.candidate;
          const imageSplit=pending?initialSplit(source.defaultSplit,source.jacketWidth):split;
          return <div key={source.jacketKey??source.jackets?.find(j=>j.chosen)?.key??'default'}
            style={pending?{position:'absolute',inset:0,visibility:'hidden',pointerEvents:'none'}:undefined}
            inert={pending||switchingJacket||undefined} aria-hidden={pending||undefined}
            onLoadCapture={event=>{if(pending&&event.target instanceof HTMLImageElement&&event.target.alt===`${code} 펼친 재킷`){
              const element=event.target;
              void(element.decode?.()??Promise.resolve()).then(()=>finishJacket(image as NonNullable<typeof selectedJacket>),()=>finishJacket(image as NonNullable<typeof selectedJacket>));
            }}}
            onErrorCapture={()=>{if(pending){setPendingJacket(null);setSwitchingJacket(false);setError('표지를 불러오지 못했습니다.');}}}>
            <AvCoverStage code={code} jacketUrl={image.url} jacketWidth={source.jacketWidth} jacketHeight={source.jacketHeight} privacy={privacy} isWrap={source.defaultSplit.isWrap}
              auto={source.defaultSplit} split={imageSplit} onSplit={setSplit} choices={resolveChoices(choices.surfaces,source.defaultSplit,imageSplit,source.jacketWidth,hasCurrent)}
              spineSource={source.spineSource&&image.spineUrl?{url:image.spineUrl,...source.spineSource}:null}
              currentImages={Object.fromEntries(SURFACES.map(s=>[s,!privacy&&currentCovers[s]?currentCovers[s]!:null])) as Record<Surface,string|null>}
              hasCurrent={hasCurrent} currentNotes={notes} disabled={disabled||busy||switchingJacket||pending}
              control={props=><SurfaceSheet {...props} disabled={disabled||busy||switchingJacket||pending} onChoose={(surface,value)=>setChoices(current=>({...current,surfaces:{...current.surfaces,[surface]:value}}))}/>}/>
          </div>;
        })}
        {(c.jackets?.length??0)>=2&&<div>
          <Button variant="quiet" aria-expanded={jacketsOpen} disabled={disabled||busy||switchingJacket} onClick={()=>setJacketsOpen(value=>!value)}>다른 표지<ChevronDownIcon aria-hidden="true"/></Button>
          {jacketsOpen&&<div ref={alternativesRef} className="av-other" role="group" aria-label="다른 표지" style={{display:'flex',gap:'var(--space-2)',flexWrap:'wrap'}}>
            {c.jackets!.map((image,index)=><button key={image.key} type="button" aria-label={`표지 ${index+1}`}
              aria-pressed={c.jacketKey===image.key||!c.jacketKey&&image.chosen}
              className={`av-cap-menu__item${(c.jacketKey===image.key||!c.jacketKey&&image.chosen)?' is-current':''}`}
              style={{width:'auto',minWidth:44,minHeight:44}} disabled={disabled||busy||switchingJacket} onClick={()=>void chooseJacket(image.key)}>
              <span className="av-menu-thumb av-menu-thumb--image">{!privacy&&jacketImages[image.key]&&<img src={jacketImages[image.key]} alt=""/>}</span>
            </button>)}
          </div>}
        </div>}
      </div>
      <AvDestination rows={rows} value={target} onChange={changeTarget} newName={choices.name} onNewName={name=>setChoices(current=>({...current,name}))}
        onOther={()=>{setOtherQuery('');setOtherOpen(true);}} otherOpen={false} privacy={privacy} disabled={disabled||busy}/>
      {target!==null&&<AvInfoSection model={model} open={details} onToggle={()=>setDetails(value=>!value)} disabled={disabled||busy}
        onField={(key,checked)=>setChoices(current=>{const fields:AvDetailFields={...current.fields};const field=FIELD_KEYS[key];if(checked)fields[field]=c.fields[field];else delete fields[field];return {...current,fields};})}
        onPerson={(id,selected)=>{const index=choices.people.findIndex(p=>p.nameJa===id);const p=choices.people[index];if(!p)return;const known=matchPerson(peopleAuthority,p);changePerson(index,{action:selected?known?'link':'new':'skip',personId:known?.personId??null});}}
        onGenre={toggleGenre}
        personControls={person=>{
          const index=choices.people.findIndex(p=>p.nameJa===person.id);const p=choices.people[index]!;
          const chosen=p.action==='link'?peopleForRole(p.role).find(candidate=>candidate.personId===p.personId):undefined;
          return {
            name:<TextInput aria-label={`${p.nameJa} 한국어 이름`} value={chosen?performerName(chosen).primary:p.displayName} maxLength={120} disabled={disabled||busy||p.action!=='new'} onChange={e=>changePerson(index,{displayName:e.target.value})}/>,
            link:<Button size="sm" variant="quiet" aria-label={`${p.nameJa} 인물 연결`} disabled={disabled||busy||p.action==='skip'} onClick={()=>{setLinkQuery('');setLinkIndex(index);}}>{p.action==='link'?'기존 인물':'새 인물'}<ChevronDownIcon aria-hidden="true"/></Button>,
          };
        }}/>}
      {mismatch&&<p role="alert" className="av-review__error">품번이 다른 컬렉션</p>}
      {error&&<p role="alert" className="av-review__error">{error}</p>}
      <footer className="av-review__foot">
        <Button variant="danger" disabled={disabled||busy||!!activePlan} onClick={onReject}>거절</Button>
        <Button variant="quiet" disabled={disabled||busy||switchingJacket||!!activePlan||detail.inbox.status!=='found'} onClick={()=>void retry()}>다시 찾기</Button>
        <span className="av-review__spacer"/><span className="av-review__summary">{summary}</span>
        <Button disabled={busy||disabled} onClick={onLater}>나중에</Button>
        <Button variant="primary" disabled={disabled||busy||switchingJacket||target===null||mismatch||(isNew&&!choices.name.trim())||choices.people.some(p=>p.action==='new'&&!p.displayName.trim())} onClick={apply}><BusyLabel busy={busy} idle={isNew?'만들기':'적용'} delay={400}>준비하는 중</BusyLabel></Button>
      </footer>
    </div>
    {otherOpen&&<BottomSheet title="다른 컬렉션" onClose={()=>setOtherOpen(false)}>
      <AvPickList label="다른 컬렉션" query={otherQuery} onQuery={setOtherQuery} items={otherItems} privacy={privacy} onPick={id=>{setOtherOpen(false);changeTarget(id);}}/>
    </BottomSheet>}
    {linkPerson&&linkIndex!==null&&<BottomSheet title={`${linkPerson.nameJa} 연결`} onClose={()=>setLinkIndex(null)}>
      <AvPickList label={`${linkPerson.nameJa} 기존 인물`} query={linkQuery} onQuery={setLinkQuery} items={linkResults}
        onPick={id=>{const person=peopleForRole(linkPerson.role).find(v=>v.personId===id);changePerson(linkIndex,{action:person?'link':'new',personId:person?.personId??null,displayName:person?.displayName??linkPerson.nameJa});setLinkIndex(null);}}
        footer={<Button variant="quiet" onClick={()=>{changePerson(linkIndex,{action:'new',personId:null,displayName:c.performers.find(v=>v.nameJa===linkPerson.nameJa)?.nameKo||linkPerson.nameJa});setLinkIndex(null);}}>새 인물로</Button>}/>
    </BottomSheet>}
  </BottomSheet>;
}
