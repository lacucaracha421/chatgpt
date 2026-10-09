import {outboxConnection} from './outboxConnection';
import {jacketPreview, type InboxDetail} from './avInbox';

let lane:Promise<unknown>=Promise.resolve();
const thumbnails=new Map<string,Promise<string>>();
const versions=new Map<string,string>();
const versionKey=(detail:InboxDetail)=>`${outboxConnection()}/${detail.inbox.requestId}/${detail.inbox.normalizedCode}/${detail.inbox.fetchedAt??''}`;
export async function jacketSha256(url:string){
  // providerImage returns the server bytes as a data URL, never a provider URL.
  const binary=atob(url.slice(url.indexOf(',')+1));
  const bytes=Uint8Array.from(binary,c=>c.charCodeAt(0));
  const hash=await crypto.subtle.digest('SHA-256',bytes);
  return Array.from(new Uint8Array(hash),b=>b.toString(16).padStart(2,'0')).join('');
}
export function loadInboxJacket(id:string,signal:AbortSignal){
  const task=lane.then(()=>jacketPreview(id,signal));lane=task.catch(()=>{});return task;
}
export async function reviewedJacket(detail:InboxDetail,signal:AbortSignal){
  const url=await loadInboxJacket(detail.inbox.id,signal);
  const sha256=await jacketSha256(url);
  versions.set(versionKey(detail),sha256);
  return {url,sha256};
}
function cropFront(detail:InboxDetail,url:string,signal:AbortSignal):Promise<string>{
  return new Promise((resolve,reject)=>{
    const image=new Image();
    const cleanup=()=>{signal.removeEventListener('abort',abort);};
    const abort=()=>{cleanup();image.onload=null;image.onerror=null;image.src='';reject(new DOMException('Cancelled','AbortError'));};
    if(signal.aborted){abort();return;}signal.addEventListener('abort',abort,{once:true});
    image.onload=()=>{cleanup();
      const c=detail.candidate!;const x=c.defaultSplit.isWrap?c.defaultSplit.x2:0;
      const width=c.jacketWidth-x,canvas=document.createElement('canvas');
      canvas.width=Math.min(120,width);canvas.height=Math.round(canvas.width*c.jacketHeight/width);
      const context=canvas.getContext('2d');if(!context){reject(new Error('표지를 만들지 못했습니다.'));return;}
      context.drawImage(image,x,0,width,c.jacketHeight,0,0,canvas.width,canvas.height);
      resolve(canvas.toDataURL('image/webp'));
    };image.onerror=()=>{cleanup();reject(new Error('표지를 읽지 못했습니다.'));};image.src=url;
  });
}
/** Only the cropped image survives the serialized decode; full jackets are released. */
export function inboxRowThumbnail(detail:InboxDetail,signal:AbortSignal):Promise<string>{
  const version=versionKey(detail),sha=detail.candidate?.jacketSha256??versions.get(version);
  const prefix=`${outboxConnection()}/${detail.inbox.requestId}/`;
  const known=sha?thumbnails.get(prefix+sha):thumbnails.get(version);if(known)return known;
  const task:Promise<string>=lane.then(async():Promise<string>=>{
    if(signal.aborted)throw new DOMException('Cancelled','AbortError');
    const url=await jacketPreview(detail.inbox.id,signal),hash=await jacketSha256(url);
    versions.set(version,hash);
    const cached=thumbnails.get(prefix+hash);if(cached&&cached!==task)return cached;
    const result=await cropFront(detail,url,signal);
    thumbnails.set(prefix+hash,Promise.resolve(result));return result;
  });
  lane=task.catch(()=>{});thumbnails.set(sha?prefix+sha:version,task);
  void task.then(()=>thumbnails.delete(version),()=>{thumbnails.delete(version);if(sha)thumbnails.delete(prefix+sha);});
  return task;
}
