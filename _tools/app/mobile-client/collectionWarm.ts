import {api,native} from './transport';
import {artworkVariant,collectionCover,collectionPath,type CollectionKind,type CollectionPage,type CollectionSummary} from './collectionModel';
import {batteryAllowsWarm,warmEnabled,type BatteryState} from './thumbnailWarm';
import {scheduleWarm} from './warmScheduler';
import {SHELF_ACTIVITY,shelfForegroundBusy} from './shelfWarmActivity';
import {SIGNAL_FALLBACK_MS,subscribeSyncSignals,syncSignal} from './syncSignals';

const KEY='lakomics.mobile.collectionWarm', EVENT='lakomics-collection-warm';
const KINDS:CollectionKind[]=['game','manga','movie','av'];
const SWEEP_AFTER=24*60*60_000;
type Artwork={collectionId:string;artworkId:string;variant:'thumbnail'|'original';revision:string;digest:string}|{assetId:string};
type Probe={generation:string;cachedIndices:number[]};
type Progress={scope:string;generation:string;revision:string;kind:number;cursor:string|null;warmed:number;completedAt:number|null};
function fresh(scope:string,generation='',revision=''):Progress{return {scope,generation,revision,kind:0,cursor:null,warmed:0,completedAt:null};}
function read(scope:string):Progress {
  try{const value=JSON.parse(localStorage.getItem(KEY)??'null') as Progress|null;
    if(value?.scope===scope&&Number.isInteger(value.kind)&&value.kind>=0&&value.kind<=KINDS.length)return value;
  }catch{/* Optional progress. */}
  return fresh(scope);
}
function save(value:Progress){try{localStorage.setItem(KEY,JSON.stringify(value));}catch{/* Optional progress. */}}
/** Exactly the thumbnail variants used by the shelf, including manga volume covers. */
function artworks(items:CollectionSummary[],revision:string):Artwork[] {
  const requests=items.flatMap(item=>{
    const ids=new Set([collectionCover(item),item.spineArtworkId,...(item.volumes??[]).map(volume=>volume.coverArtworkId)].filter((id):id is string=>!!id));
    const result:Artwork[]=[...ids].map(artworkId=>{const variant=artworkVariant(item,artworkId);return {collectionId:item.id,artworkId,variant,revision,digest:item.artworkVersions?.[artworkId]?.[variant]??''};});
    if(!collectionCover(item)&&item.coverAssetId)result.push({assetId:item.coverAssetId});
    return result;
  });
  return [...new Map(requests.map(item=>[JSON.stringify(item),item])).values()];
}
async function probe(items:Artwork[],signal:AbortSignal) {
  const result=await native<Probe>('collectionArtworksCached',{items},signal);
  if(!result.generation||!Array.isArray(result.cachedIndices))throw new Error('Invalid artwork probe');
  return result;
}
async function pass(scope:string,signal:AbortSignal) {
  const allowed=async()=>batteryAllowsWarm((await native<{battery?:BatteryState}>('status',{},signal)).battery);
  if(!await allowed())return false;
  // Check both identities before trusting a saved cursor or a completed pass. Native's
  // opaque generation includes the account and persists across process restarts.
  const publication=await api<{revision:string|null}>('/v1/collections/status',signal);
  if(!publication.revision)throw new Error('Publication unavailable');
  const identity=await probe([],signal);
  if(signal.aborted)return;
  let progress=read(scope);
  if(progress.generation!==identity.generation||progress.revision!==publication.revision)progress=fresh(scope,identity.generation,publication.revision);
  if(progress.completedAt!==null){
    if(Date.now()-progress.completedAt<SWEEP_AFTER)return;
    progress=fresh(scope,identity.generation,publication.revision);
  }
  save(progress);
  while(progress.kind<KINDS.length){
    const page=await api<CollectionPage>(collectionPath(KINDS[progress.kind], '',false,progress.cursor),signal);
    if(signal.aborted)return;
    if(!page.ready||page.revision!==progress.revision){save(fresh(scope));throw new Error('Publication changed');}
    const requests=artworks(page.items,progress.revision);
    for(let offset=0;offset<requests.length;offset+=100){
      const batch=requests.slice(offset,offset+100),cached=await probe(batch,signal);
      if(signal.aborted)return;
      if(cached.generation!==progress.generation){save(fresh(scope));throw new Error('Cache changed');}
      const hits=new Set(cached.cachedIndices),missing=batch.filter((_,index)=>!hits.has(index));
      // Only two speculative bridge requests exist at once. Foreground activity aborts
      // this owner immediately, including queued native work, before visible loads start.
      for(let index=0;index<missing.length;index+=2){
        if(!await allowed())return false;
        if(signal.aborted)return;
        await Promise.all(missing.slice(index,index+2).map(item=>native('assetId' in item?'thumbnail':'collectionArtwork',item,signal)));
      }
      if(missing.length){
        const verified=await probe(missing,signal);
        if(signal.aborted)return;
        if(verified.generation!==progress.generation){save(fresh(scope));throw new Error('Cache changed');}
        if(verified.cachedIndices.length!==missing.length)throw new Error('Artwork page incomplete');
      }
    }
    if(signal.aborted)return;
    progress={...progress,warmed:progress.warmed+requests.length,cursor:page.nextCursor,kind:page.nextCursor?progress.kind:progress.kind+1};
    if(progress.kind===KINDS.length)progress.completedAt=Date.now();
    save(progress);
  }
}
/** Shelf warming shares the Library's visible/idle/metered/power policy and opt-out. */
export function startCollectionWarm(scope:string) {
  const reset=()=>{try{localStorage.removeItem(KEY);}catch{/* Optional progress. */}};
  window.addEventListener('lakomics-media-cache-cleared',reset);
  let seen=syncSignal('collections');
  const unsignal=subscribeSyncSignals(()=>{const next=syncSignal('collections');if(next!==undefined&&next!==seen){seen=next;window.dispatchEvent(new Event(EVENT));}});
  const stop=scheduleWarm({enabled:warmEnabled,pass:signal=>pass(scope,signal),publish:()=>{},progress:()=>read(scope),
    repeatAfter:SIGNAL_FALLBACK_MS,event:'lakomics-thumbnail-warm',blocked:shelfForegroundBusy,
    wakeEvents:[SHELF_ACTIVITY,EVENT,'lakomics-media-cache-cleared']});
  return ()=>{stop();unsignal();window.removeEventListener('lakomics-media-cache-cleared',reset);};
}
