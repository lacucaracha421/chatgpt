import {afterEach,beforeEach,expect,it,vi} from 'vitest';
const mocks=vi.hoisted(()=>({api:vi.fn(),native:vi.fn()}));
vi.mock('./transport',()=>({api:mocks.api,native:mocks.native}));
import {startCollectionWarm} from './collectionWarm';
import {START_DELAY} from './warmScheduler';
import {setWarmEnabled} from './thumbnailWarm';
import {artworkTicket} from './collectionArtwork';
import {catalogImageTicket} from './catalogMedia';
import {clearMediaCache} from './media';
import type {CollectionSummary} from './collectionModel';
const KEY='lakomics.mobile.collectionWarm';
let stop:(()=>void)|undefined,generation:string,revision:string,battery:{charging:boolean;level:number;powerSave:boolean};
let items:CollectionSummary[],delay:number,active:number,peak:number;
const cache=new Set<string>();
const key=(item:Record<string,unknown>)=>JSON.stringify(item.assetId?['asset',item.assetId]:[item.collectionId,item.artworkId,item.variant,item.digest||item.revision]);
const work=(i:number):CollectionSummary=>({id:`c${i}`,name:`Work ${i}`,type:'game',showcase:false,selectedWorkArtworkId:'cover',spineArtworkId:'spine'});
const downloads=()=>mocks.native.mock.calls.filter(([op])=>op==='collectionArtwork'||op==='thumbnail');
const pages=()=>mocks.api.mock.calls.filter(([path])=>path.startsWith('/v1/collections?'));
const progress=()=>JSON.parse(localStorage.getItem(KEY)??'null');
const advance=async(ms=START_DELAY+500)=>{await vi.advanceTimersByTimeAsync(ms);};
beforeEach(()=>{
  vi.useFakeTimers();localStorage.clear();setWarmEnabled(true);cache.clear();generation='account-a/cache-1';revision='r1';
  battery={charging:false,level:80,powerSave:false};items=[work(1),work(2)];delay=0;active=0;peak=0;
  mocks.api.mockImplementation(async(path:string)=>{
    if(path==='/v1/collections/status')return {revision};
    const params=new URL(path,'https://fixture.invalid').searchParams,offset=Number(params.get('cursor')??0);
    const list=items.filter(item=>item.type===params.get('type'));
    return {ready:true,revision,items:list.slice(offset,offset+48),nextCursor:offset+48<list.length?String(offset+48):null};
  });
  mocks.native.mockImplementation(async(op:string,payload:Record<string,unknown>,signal?:AbortSignal)=>{
    if(op==='status')return {battery};
    if(op==='collectionArtworksCached')return {generation,cachedIndices:(payload.items as Record<string,unknown>[]).flatMap((item,index)=>cache.has(key(item))?[index]:[])};
    active++;peak=Math.max(peak,active);
    try{
      if(delay)await new Promise<void>((resolve,reject)=>{const timer=setTimeout(resolve,delay);signal?.addEventListener('abort',()=>{clearTimeout(timer);reject(new DOMException('Cancelled','AbortError'));},{once:true});});
      if(signal?.aborted)throw new DOMException('Cancelled','AbortError');
      cache.add(key(payload));return {url:'https://app.lakomics.local/media-cache/0/test'};
    }finally{active--;}
  });
});
afterEach(()=>{stop?.();stop=undefined;clearMediaCache();vi.useRealTimers();vi.restoreAllMocks();vi.unstubAllGlobals();mocks.api.mockReset();mocks.native.mockReset();});
it('starts after launch/idle and walks all four kinds, two images at a time',async()=>{
  delay=100;items.push({...work(3),type:'manga'},{...work(4),type:'movie'},{...work(5),type:'av'});
  stop=startCollectionWarm('endpoint');await advance(START_DELAY-1);expect(mocks.api).not.toHaveBeenCalled();
  await advance(2000);expect(progress().completedAt).not.toBeNull();expect(peak).toBe(2);expect(downloads()).toHaveLength(10);expect(pages()).toHaveLength(4);
});
it('probes before downloading and deduplicates cover/spine/volume identities',async()=>{
  items=[{...work(1),spineArtworkId:'cover',volumes:[{id:'v',editionIndex:0,volumeNumber:1,displayLabel:'1',coverArtworkId:'cover'}]}];
  stop=startCollectionWarm('endpoint');await advance();expect(downloads()).toHaveLength(1);
  stop();mocks.native.mockClear();mocks.api.mockClear();stop=startCollectionWarm('endpoint');await advance();
  expect(downloads()).toHaveLength(0);expect(pages()).toHaveLength(0);
});
it('resumes a partially downloaded page across restart without duplicate downloads',async()=>{
  delay=1000;stop=startCollectionWarm('endpoint');await advance(START_DELAY+1100);expect(cache.size).toBe(2);stop();
  delay=0;stop=startCollectionWarm('endpoint');await advance();expect(cache.size).toBe(4);
  expect(downloads().filter(([,p])=>p.collectionId==='c1')).toHaveLength(2);expect(progress().completedAt).not.toBeNull();
});
it('resumes at the saved page and keeps a failed page for retry',async()=>{
  items=Array.from({length:50},(_,i)=>work(i));const original=mocks.api.getMockImplementation()!;let fail=true;
  mocks.api.mockImplementation((path:string)=>{if(path.includes('cursor=48')&&fail){fail=false;throw new Error('offline');}return original(path);});
  stop=startCollectionWarm('endpoint');await advance();expect(progress().cursor).toBe('48');stop();mocks.api.mockClear();
  stop=startCollectionWarm('endpoint');await advance();expect(pages()[0][0]).toContain('cursor=48');expect(downloads()).toHaveLength(100);
});
it('cancels in-flight warming for a foreground cover and waits until it finishes',async()=>{
  delay=5000;stop=startCollectionWarm('endpoint');await advance(START_DELAY+1);expect(active).toBe(2);
  const visible=artworkTicket(work(99),'cover','r1',false,new AbortController().signal);await advance(0);
  expect(active).toBe(1);const before=downloads().length;await advance(4000);expect(downloads()).toHaveLength(before);
  await advance(1000);await visible;delay=0;await advance(3100);expect(progress().completedAt).not.toBeNull();
});
it('also yields the collection warm workers to pending catalog covers',async()=>{
  delay=5000;stop=startCollectionWarm('endpoint');await advance(START_DELAY+1);expect(active).toBe(2);
  const cover=catalogImageTicket({workId:'42',revision:'a'.repeat(64),kind:'cover',index:0,url:'https://ehgt.org/42.jpg'},new AbortController().signal);
  await advance(0);expect(active).toBe(1);
  const before=downloads().length;await advance(4000);expect(downloads()).toHaveLength(before);
  await advance(1000);await cover;delay=0;await advance(3100);expect(progress().completedAt).not.toBeNull();
});
it.each(['scroll','pointerdown','wheel'])('pauses for %s and resumes after idle',async event=>{
  delay=5000;stop=startCollectionWarm('endpoint');await advance(START_DELAY+1);window.dispatchEvent(new Event(event));await advance(0);expect(active).toBe(0);
  const before=downloads().length;await advance(2999);expect(downloads()).toHaveLength(before);delay=0;await advance(100);expect(progress().completedAt).not.toBeNull();
});
it.each(['clear','account','revision'])('restarts a completed shelf after %s changes',async change=>{
  stop=startCollectionWarm('endpoint');await advance();stop();mocks.api.mockClear();mocks.native.mockClear();
  if(change==='revision')revision='r2';else{generation=change==='account'?'account-b/cache-1':'account-a/cache-2';cache.clear();}
  stop=startCollectionWarm('endpoint');await advance();expect(pages()).toHaveLength(4);expect(downloads()).toHaveLength(4);
});
it('cache clear wakes a running owner without an app restart',async()=>{
  stop=startCollectionWarm('endpoint');await advance();mocks.native.mockClear();generation='cache-2';cache.clear();clearMediaCache();await advance(3500);
  expect(downloads()).toHaveLength(4);expect(progress().generation).toBe('cache-2');
});
it.each([{type:'cellular'},{saveData:true}])('does not warm a metered/data-saving link %j',async connection=>{
  vi.stubGlobal('navigator',{...navigator,connection});stop=startCollectionWarm('endpoint');await advance();expect(mocks.api).not.toHaveBeenCalled();
});
it.each([{charging:false,level:49,powerSave:false},{charging:false,level:90,powerSave:true}])('waits for an allowed battery %j',async value=>{
  battery=value;stop=startCollectionWarm('endpoint');await advance();expect(mocks.api).not.toHaveBeenCalled();
  battery={charging:true,level:10,powerSave:false};window.dispatchEvent(new Event('lakomics-power'));await advance();expect(progress().completedAt).not.toBeNull();
});
it('does not run while hidden or opted out',async()=>{
  setWarmEnabled(false);stop=startCollectionWarm('endpoint');await advance();expect(mocks.api).not.toHaveBeenCalled();stop();setWarmEnabled(true);
  vi.spyOn(document,'visibilityState','get').mockReturnValue('hidden');stop=startCollectionWarm('endpoint');await advance();expect(mocks.api).not.toHaveBeenCalled();
});
it('reports bounded cold and cached request counts for a 200-collection shelf',async()=>{
  delay=1;items=Array.from({length:200},(_,i)=>work(i));stop=startCollectionWarm('endpoint');await advance();
  const cold={pages:pages().length,probes:mocks.native.mock.calls.filter(([op])=>op==='collectionArtworksCached').length,downloads:downloads().length,peak};
  expect(cold).toEqual({pages:8,probes:11,downloads:400,peak:2});
  stop();mocks.native.mockClear();mocks.api.mockClear();vi.setSystemTime(Date.now()+24*60*60_000+1);stop=startCollectionWarm('endpoint');await advance();
  const warm={pages:pages().length,probes:mocks.native.mock.calls.filter(([op])=>op==='collectionArtworksCached').length,downloads:downloads().length};
  expect(warm).toEqual({pages:8,probes:6,downloads:0});
  console.info(`[perf] shelf warm (200 collections, cover+spine): cold=${JSON.stringify(cold)} cachedSweep=${JSON.stringify(warm)}; each cold artwork uses one existing ticket + one download; probes are local only`);
});

it('a metadata-only publication restarts the walk but keeps unchanged digests',async()=>{
  items=items.map(item=>({...item,artworkVersions:{cover:{thumbnail:'same-cover'},spine:{thumbnail:'same-spine'}}}));
  stop=startCollectionWarm('endpoint');await advance();stop();mocks.native.mockClear();mocks.api.mockClear();revision='r2';
  stop=startCollectionWarm('endpoint');await advance();expect(pages()).toHaveLength(4);expect(downloads()).toHaveLength(0);
});
it('native pause cancels transfers even before WebView becomes hidden',async()=>{
  delay=5000;stop=startCollectionWarm('endpoint');await advance(START_DELAY+1);
  window.dispatchEvent(new Event('lakomics-pause'));await advance(START_DELAY*2);expect(active).toBe(0);expect(progress().completedAt).toBeNull();
  delay=0;window.dispatchEvent(new Event('lakomics-resume'));await advance();expect(progress().completedAt).not.toBeNull();
});
it('power loss interrupts a running pair, then waits for charging',async()=>{
  delay=5000;stop=startCollectionWarm('endpoint');await advance(START_DELAY+1);
  battery={charging:false,level:20,powerSave:false};window.dispatchEvent(new Event('lakomics-power'));await advance(3500);expect(active).toBe(0);
  const before=downloads().length;await advance(60_000);expect(downloads()).toHaveLength(before);
  battery={charging:true,level:20,powerSave:false};delay=0;window.dispatchEvent(new Event('lakomics-power'));await advance();expect(progress().completedAt).not.toBeNull();
});
it('a publication signal wakes a completed owner',async()=>{
  stop=startCollectionWarm('endpoint');await advance();mocks.api.mockClear();revision='r2';
  window.dispatchEvent(new CustomEvent('lakomics-sync-signals',{detail:{live:true,signals:{collections:{revision}}}}));
  await advance(3500);expect(pages()).toHaveLength(4);expect(progress().revision).toBe('r2');
});
it('warms legacy cover assets through the matching native thumbnail key',async()=>{
  items=[{...work(1),selectedWorkArtworkId:null,spineArtworkId:null,coverAssetId:'a1'}];
  stop=startCollectionWarm('endpoint');await advance();expect(downloads()).toEqual([['thumbnail',{assetId:'a1'},expect.any(AbortSignal)]]);
});
it('a failed download cancels its sibling before a foreground request can arrive',async()=>{
  delay=10_000;const original=mocks.native.getMockImplementation()!;
  mocks.native.mockImplementation((op,payload,signal)=>op==='collectionArtwork'&&payload.artworkId==='cover'?Promise.reject(new Error('offline')):original(op,payload,signal));
  stop=startCollectionWarm('endpoint');await advance(START_DELAY+1);expect(active).toBe(0);expect(progress().completedAt).toBeNull();
});
it('does not mark a page done when native replies without durable cache bytes',async()=>{
  const original=mocks.native.getMockImplementation()!;
  mocks.native.mockImplementation((op,payload,signal)=>op==='collectionArtwork'?Promise.resolve({url:'https://example.invalid/temporary'}):original(op,payload,signal));
  stop=startCollectionWarm('endpoint');await advance();expect(progress().completedAt).toBeNull();expect(pages()).toHaveLength(1);
});
