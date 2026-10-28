import {rememberPersonNames} from './personNameCache';
import type {ProfilePerson} from "../src/collections/av/personProfileFields";
import {api, native} from './transport';
import {outboxConnection} from './outboxConnection';
import {sameAuthority, type AuthorityIdentity, type BlobReceipt} from './collectionCommandOutbox';
import type {AvCredit, AvDetailFields} from './avEditModel';
import {candidateAvailable, sameSplit, spineIsBorrowedByDefault} from '../src/collections/avReview/avReviewModel';

export type InboxItem = {id:string;requestId:string;sequence:number;productCode:string;normalizedCode:string|null;sourceUrl?:string|null;receivedAt:string;fetchedAt?:string|null;status:'queued'|'fetching'|'found'|'not_found'|'error'|'dismissed'|'applied';titleJa:string|null;lastError:string|null;appliedWorkId:string|null};
export type Surface = 'front'|'spine'|'back';
export const SURFACES:Surface[] = ['front','spine','back'];
export const SURFACE_LABELS:Record<Surface,string> = {front:'앞표지',spine:'책등',back:'뒤표지'};
export type CandidatePerson = {nameJa:string;nameKo:string|null;wikidataId:string|null;fanzaActressId:string|null};
export type InboxJacket = {key:string;url:string;width:number;height:number;hasSpine:boolean;chosen:boolean;sha256:string;defaultSplit:InboxCandidate['defaultSplit'];spineSource?:InboxCandidate['spineSource']};
export type InboxCandidate = {jackets?:InboxJacket[];jacketKey?:string;fields:AvDetailFields; jacketSha256?:string;jacketUrl:string;jacketWidth:number;jacketHeight:number;defaultSplit:{x1:number;x2:number;isWrap:boolean;useSpine:boolean};performers:CandidatePerson[];/** Directors are no longer imported; older servers still send them. */directors?:CandidatePerson[];/** The DVD cover a borrowed spine is cut from (`jacketPreview(id, signal, 'spine-source')`). */spineSource?:{width:number;height:number;x1:number;x2:number}|null};
export type InboxDetail = {inbox:InboxItem;candidate:InboxCandidate|null;matches:{libraryId:string;workId:string;name:string;entityRevision:number}[]};
export type PreparedArtwork = {surface:Surface;kind:string;provider:string;providerImageId:string;width:number;height:number;language:string|null;original:BlobReceipt;thumbnail:BlobReceipt|null};
export type InboxWork = {workId:string;type:string;name:string;lifecycle:string;entityRevision:number;selection:Record<string,string|null>;details:{av?:AvDetailFields};avCredits:AvCredit[];avPeople?:InboxPerson[]};
export type InboxPerson = ProfilePerson & {personId:string;displayName:string;nameJa:string|null};
export type InboxArtwork = {workId:string;artworkId:string;kind:string;provider:string;providerImageId:string|null};
export type InboxAuthority = {identity:AuthorityIdentity;snapshotCursor?:number;works:InboxWork[];artworks:InboxArtwork[];people:InboxPerson[]};
export const inboxPath = (id:string) => `/v1/av-inbox/${encodeURIComponent(id)}`;
export const inboxDetail = (id:string, signal?:AbortSignal) => api<InboxDetail>(inboxPath(id), signal);
export async function reviewedInboxDetail(id:string,connection=outboxConnection(),signal=new AbortController().signal,jacketKey?:string):Promise<InboxDetail>{
  const detail=await api<InboxDetail>(inboxPath(id),signal,undefined,'GET',false,connection??undefined);
  if(detail.candidate){
    if(jacketKey)detail.candidate=selectInboxJacket(detail.candidate,jacketKey);
    const {reviewedJacket,jacketSha256}=await import('./avInboxThumbnail');
    const jacket=jacketKey?{sha256:await jacketSha256(await jacketPreview(id,signal,'jacket',jacketKey))}:await reviewedJacket(detail,signal);
    detail.candidate={...detail.candidate,jacketSha256:jacket.sha256};
  }
  return detail;
}
export async function inboxList(signal?:AbortSignal):Promise<InboxItem[]> {
  const connection=outboxConnection(); if(!connection) throw new Error('서버 연결을 확인해 주세요.');
  const items:InboxItem[]=[];let before:number|null=null;
  do {
    const page: {items:InboxItem[];hasMore:boolean;nextBefore:number|null} = await api(`/v1/av-inbox?limit=100${before===null?'':`&before=${before}`}`,signal,undefined,'GET',false,connection);
    if(connection!==outboxConnection()) throw new Error('서버 연결이 바뀌었습니다.');
    items.push(...page.items); const next=page.hasMore?page.nextBefore:null;
    if(next!==null&&(next===before||!Number.isSafeInteger(next))) throw new Error('목록 응답을 확인하지 못했습니다.');
    before=next;
  } while(before!==null);
  return items.sort((a,b)=>b.sequence-a.sequence);
}
/** A frozen authority baseline supplies actual selections, manual provenance and people. */
export async function readInboxAuthority(identity:AuthorityIdentity,signal?:AbortSignal):Promise<InboxAuthority> {
  const connection=outboxConnection();if(!connection)throw new Error('서버 연결을 확인해 주세요.');
  const path='/v1/collections/authority/baseline';
  const params=new URLSearchParams({libraryId:identity.libraryId,epoch:String(identity.epoch)});
  const manifest=await api<AuthorityIdentity&{snapshotCursor:number}>(`${path}?${params}`,signal,undefined,'GET',false,connection);
  if(!sameAuthority(manifest,identity))throw new Error('라이브러리가 변경되었습니다. 다시 열어 주세요.');
  params.set('snapshot',String(manifest.snapshotCursor));
  const result:InboxAuthority={identity,works:[],artworks:[],people:[],snapshotCursor:manifest.snapshotCursor};
  for(const section of ['works','artworks'] as const){
    params.set('section',section);params.delete('after');let after:string|null=null;
    do {
      if(after)params.set('after',after);
      const page=await api<AuthorityIdentity&{items:unknown[];hasMore:boolean;nextAfter:string|null}>(`${path}?${params}`,signal,undefined,'GET',false,connection);
      if(!sameAuthority(page,identity)||connection!==outboxConnection())throw new Error('라이브러리가 변경되었습니다. 다시 열어 주세요.');
      (result[section] as unknown[]).push(...page.items);
      const next=page.hasMore?page.nextAfter:null;
      if(page.hasMore&&(!next||next===after))throw new Error('목록 응답을 확인하지 못했습니다.');
      after=next;
    } while(after);
  }
  for(const work of result.works)work.avCredits=work.avCredits.map(({personId,role,order,creditName})=>({personId,role,order,creditName:creditName??null}));
  for(const work of result.works)for(const person of work.avPeople??[])if(!result.people.some(p=>p.personId===person.personId))result.people.push(person);
  rememberPersonNames(result.people, connection);
  return result;
}
/** `spine-source`: the DVD cover a borrowed spine is cut from. */
export async function jacketPreview(id:string,signal:AbortSignal,part:'jacket'|'spine-source'='jacket',jacketKey?:string):Promise<string> {
  const connection=outboxConnection();if(!connection)throw new Error('서버 연결을 확인해 주세요.');
  const reply=await native<{url:string}>('providerImage',{path:`${inboxPath(id)}/${part}${jacketKey?`?jacketKey=${encodeURIComponent(jacketKey)}`:''}`,connection},signal);
  return reply.url;
}
/** useSpine on a wrap whose lines enclose nothing: the jacket has no spine of its own, the server cuts it from the DVD cover. */
export const spineBorrowed=(c:InboxCandidate)=>spineIsBorrowedByDefault(c.defaultSplit);
/** The server's own split gives its useSpine rule; lines the user moved give the review's rule (a gap of at least 1%, or a borrowed spine). */
export const candidateHasSurface=(c:InboxCandidate,s:Surface,split?:{x1:number;x2:number})=>{
  if(s==='front')return true;
  if(!c.defaultSplit.isWrap)return false;
  if(!split||sameSplit(split,c.defaultSplit))return s==='back'?c.defaultSplit.x1>0:c.defaultSplit.useSpine;
  return candidateAvailable(c.defaultSplit,split,c.jacketWidth,s);
};

/** Project the selected jacket so crop validation and durable apply use the same image. */
export function selectInboxJacket(candidate:InboxCandidate,key?:string):InboxCandidate {
  if(!key)return candidate;
  const image=candidate.jackets?.find(j=>j.key===key);
  if(!image)throw new Error('표지 후보가 변경되었습니다. 다시 확인해 주세요.');
  return {...candidate,jacketKey:key,jacketUrl:image.url,jacketWidth:image.width,jacketHeight:image.height,
    defaultSplit:image.defaultSplit,spineSource:image.spineSource??null,jacketSha256:image.sha256};
}
