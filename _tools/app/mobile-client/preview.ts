import type {MobileNote} from './Notes';
let demoNotes:MobileNote[]=[{id:'a'.repeat(32),title:'다음에 볼 작품',body:'마음에 남은 장면과 감상을 적어 두세요.',pinned:true,deleted:false,createdAt:'2026-09-13',updatedAt:'2026-09-13',localRevision:1,pending:false,conflict:false}];
// Development-only fixtures. Vite removes this module from the production APK.
import type {RefreshJob} from './CatalogRefresh';
let refreshDemo:{job:RefreshJob;started:number}|null=null;
import type {Asset} from './types';
import type {CollectionDetail} from './collectionModel';
const palettes = [['#b8b1a0','#474d48','#7a8176','#d8cbb2'],['#afc0bb','#31464a','#607d7a','#d3d3bf'],['#c5ab98','#483d46','#826a73','#e2c9a8'],['#b6b7c4','#363d57','#737c93','#d4cbc3']];
function art(index: number, w: number, h: number) {
  const p = palettes[index % palettes.length];
  return `data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 600 800" preserveAspectRatio="none"><rect width="600" height="800" fill="${p[0]}"/><circle cx="${180+index%3*95}" cy="190" r="85" fill="${p[3]}"/><path d="M0 480L140 280 320 580 460 370 600 490V800H0" fill="${p[2]}"/><path d="M0 610L240 420 430 630 600 530V800H0" fill="${p[1]}"/><path d="M290 800L370 600 343 482 393 607 346 800" fill="${p[3]}" opacity=".7"/><path d="M25 25H575V775H25Z" fill="none" stroke="${p[3]}" opacity=".3"/><text x="45" y="745" fill="${p[3]}" font-family="sans-serif" font-size="15" letter-spacing="7">STUDY / ${String(index+1).padStart(2,'0')}</text></svg>`)}`;
}
const authors = ['bluealex1203','YanghuiyaRBQ','koragen1925','moon_archive','atelier.04'];
const assets: Asset[] = Array.from({length:120}, (_, i) => {
  const [w,h] = [[600,800],[900,600],[600,960],[800,800],[1200,680]][i%5];
  return {id:`demo-${i}`,kind:'image',width:w,height:h,ratio:w/h,creator_handle:authors[i%authors.length],collected_at:`2026-09-${String(6 - Math.floor(i/25)).padStart(2,'0')}T12:00:00Z`,content_type:'image/svg+xml',size_bytes:483217,thumbnail_available:true,preview:art(i,w,h)};
});
const collectionNames={game:['여름의 항로','조용한 행성','먼 바다의 기억','숲의 기록'],manga:['밤의 도서관','여름과 파도','푸른 궤도','작은 정원'],movie:['오후의 빛','도시의 창','먼 곳에서','겨울의 초상']};
const collections:CollectionDetail[]=(['game','manga','movie'] as const).flatMap(type=>Array.from({length:12},(_,i)=>({id:`collection-${type}-${i}`,name:collectionNames[type][i%4]+(i>3?` ${Math.floor(i/4)+1}`:''),type,publisher:type==='game'?'Field Publishing':null,platforms:type==='game'?'Windows · PlayStation · Switch':null,genres:type==='manga'?'판타지 · 모험':'드라마 · 모험',seasonDateRange:type==='movie'&&i%2===0?['2024-04-01','2026-06-30']:null,productionCompany:type==='movie'?'Studio Archive':null,externalScore:type==='movie'?86:null,runtimeMinutes:type==='movie'?24:null,series:type==='movie'?{status:'방영 종료',cast:['서유진','하루'],seasons:[{id:1,seasonNumber:1,name:'시즌 1',airDate:'2024-04-01',posterArtworkId:`cover-${i}`,episodes:Array.from({length:12},(_,episode)=>({id:episode+1,episodeNumber:episode+1,name:`기억의 장면 ${episode+1}`,airDate:'2024-04-01',runtimeMinutes:24}))}]}:null,showcase:i<7,showcaseOrder:i,year:2024+i%3,myScore:i%4===0?null:i%2===0?4.5:3,createdAt:`2026-09-${String(i+1).padStart(2,'0')}T00:00:00Z`,author:type==='manga'?'서유진':null,developer:type==='game'?'Studio Field':null,director:type==='movie'?'이수현':null,selectedWorkArtworkId:`cover-${i}`,selectedHeroArtworkId:type==='game'?`hero-${i}`:null,selectedBackdropArtworkId:type==='movie'?`hero-${i}`:null,overview:'조용히 보관해 두었다가 다시 꺼내 보는 작품. 빛과 계절, 그리고 오래 남아 있는 장면들을 따라갑니다.',volumes:type==='manga'?Array.from({length:8},(_,v)=>({id:`volume-${v}`,volumeNumber:v%5+1,editionIndex:v<5?0:1,displayLabel:`${v%5+1}권`,coverArtworkId:`volume-cover-${v}`})):[],artworks:[{id:`hero-${i}`,kind:'hero',selected:true,thumbnailAvailable:true,originalAvailable:true},{id:`cover-${i}`,kind:'cover',selected:true,thumbnailAvailable:true,originalAvailable:true}]})));
export async function demoTransport(op: string, payload: Record<string, unknown>): Promise<unknown> {
  await new Promise(resolve => setTimeout(resolve, 80));
  if(op==='notesState'||op==='notesSync'||op==='notesUnlock')return {unlocked:true,notes:demoNotes,lastSyncedAt:new Date().toISOString()};
  if(op==='notesSave'){const note={...payload,localRevision:Number(payload.expectedRevision)+1,pending:false,conflict:false,createdAt:new Date().toISOString(),updatedAt:new Date().toISOString()} as MobileNote;demoNotes=[note,...demoNotes.filter(n=>n.id!==note.id)];return note;}
  if (op === 'collectionArtwork') {const index=Number(String(payload.artworkId).match(/\d+$/)?.[0]??0);return {url:art(index,String(payload.artworkId).startsWith('hero')?1200:600,String(payload.artworkId).startsWith('hero')?600:800),expires_in:240};}
  if (op === 'cacheStatus' || op === 'clearCache') return {bytes:0,count:0,limit:1024*1024*1024};
  if (op === 'thumbnail' || op === 'media') return {url:assets.find(asset => asset.id === payload.assetId)?.preview,expires_in:240};
  if (op === 'catalogImage') {const index=Number(payload.index??0)+(Number(payload.workId??1)%7);return {url:art(index,900,1350),expires_in:240};}
  if (op === 'pickerStatus' || op === 'pickerRefresh') return {supported:true,eligible:false,selected:false,syncing:false,scanned:120,mediaCount:120,albumCount:7,ready:true,lastSyncedAt:Date.now(),error:''};
  if (op === 'status' || op === 'configure') return {configured:true,endpoint:'https://preview.invalid'};
  if (op === 'disconnect') return {configured:false,endpoint:''};
  if (op !== 'api') return {};
  const url = new URL(String(payload.path),'https://preview.invalid');
  if(url.pathname.startsWith('/v1/library/characters')) {
    const revision='a'.repeat(64);
    const nodes=[
      {id:'series:demo',kind:'series',sourceId:'demo',seriesId:'demo',parentId:null,name:'아카이브 시리즈',description:'',heroAssetId:'demo-0',thumbnailAssetId:'demo-0',manualOnly:false,excluded:false},
      {id:'group:demo',kind:'group',sourceId:'demo',seriesId:'demo',parentId:'series:demo',name:'주요 캐릭터',description:'',thumbnailAssetId:'demo-1',manualOnly:false,excluded:false},
      {id:'folder:demo',kind:'folder',sourceId:'demo',seriesId:'demo',parentId:'series:demo',name:'배경 자료',description:'',thumbnailAssetId:'demo-4',manualOnly:false,excluded:true},
      ...Array.from({length:15},(_,i)=>({id:`character:demo-${i}`,kind:'character',sourceId:`demo-${i}`,seriesId:'demo',parentId:i<3?'group:demo':'series:demo',name:['서하','유리','하늘'][i%3]+(i>2?` ${i+1}`:''),description:'보관된 캐릭터 자료',thumbnailAssetId:`demo-${i}`,manualOnly:i%3===0,excluded:false}))
    ];
    const scopes=nodes.flatMap(n=>(n.kind==='series'?['all','unclassified','needs_review']:['all']).map(filter=>({nodeId:n.id,filter,totalCount:filter==='all'?120:0,sourceCount:filter==='all'?120:0})));
    if(url.pathname.endsWith('/characters'))return {version:1,authority:'pc',authorityEpoch:0,capabilities:{read:true,write:false},ready:true,revision,publishedAt:'2026-09-13T00:00:00Z',nodes,scopes};
    const selected=url.searchParams.get('filter')==='all'?assets:[];
    const offset=Number(url.searchParams.get('cursor')??0),limit=40;
    return {revision,items:selected.slice(offset,offset+limit),totalCount:selected.length,sourceCount:selected.length,has_more:offset+limit<selected.length,next_cursor:offset+limit<selected.length?String(offset+limit):null};
  }
  if(url.pathname==='/v1/collections/status')return {revision:'demo-1'};
  if(url.pathname==='/v1/mobile-catalog/status')return {publicationRevision:'demo-catalog',capabilities:{refreshRequest:true}};
  if(url.pathname==='/v1/mobile-catalog/refresh'){
    if(payload.method==='POST'){
      const body=payload.body as {operationId:string;language:'korean'|'japanese'};
      refreshDemo={started:Date.now(),job:{id:body.operationId,language:body.language,state:'running',pages:0,added:0,hasMore:false,error:null,publicationRevision:null}};
    }
    if(refreshDemo&&Date.now()-refreshDemo.started>3000)refreshDemo.job={...refreshDemo.job,state:'completed',pages:1,publicationRevision:'demo-catalog'};
    return {job:refreshDemo?.job??null};
  }
  if(url.pathname.startsWith('/v1/mobile-catalog/')){
    const catalog=Array.from({length:48},(_,i)=>({provider:'kHentai',providerWorkId:String(i+1),groupId:`demo-group-${i}`,title:['밤의 도서관','여름의 항로','계절의 기록','조용한 정원','먼 바다에서','푸른 궤도'][i%6]+(i>5?` ${Math.floor(i/6)+1}`:''),titleJpn:null,artists:['서유진','Studio Field','하루'][i%3].split(','),series:[],thumbnailUrl:art(i,600,900),bookmarked:i%3===0,hasBookmarkedVersion:i%3===0,fileCount:24+i*2,views:12480-i*167,posted:1788000000-i*86400,versionCount:i%5===0?2:1}));
    const decode=(name:string)=>JSON.parse(url.searchParams.get(name)??'{}') as {offset?:number;language?:string;text?:string;scope?:string;limit?:number};
    if(url.pathname.endsWith('/search')){
      const q=url.searchParams.has('cursor')?decode('cursor'):{language:url.searchParams.get('language')??'korean',text:url.searchParams.get('text')??'',scope:url.searchParams.get('scope')??'all',limit:40};
      const selected=catalog.filter((item,i)=>(q.language==='all'||i%2===(q.language==='japanese'?1:0))&&(!q.text||item.title.includes(q.text))&&(q.scope!=='bookmarked'||item.bookmarked));
      const offset=q.offset??0,limit=q.limit??40,context=JSON.stringify({...q,offset:0});
      return {ready:true,publicationRevision:'demo-catalog',publishedAt:'2026-09-08T00:00:00Z',items:selected.slice(offset,offset+limit),nextCursor:offset+limit<selected.length?JSON.stringify({...q,offset:offset+limit}):null,context,countToken:null,totalCount:selected.length,countStatus:'ready'};
    }
    if(url.pathname.endsWith('/count'))return {publicationRevision:'demo-catalog',totalCount:JSON.parse(url.searchParams.get('token')??'{}').count??0};
    if(url.pathname.endsWith('/reader')){const workId=url.pathname.split('/').slice(-2)[0];return {publicationRevision:'demo-catalog',provider:'kHentai',providerWorkId:workId,manifestExpiresAt:1800000000,pages:Array.from({length:28},(_,index)=>({index,url:`https://demo.siam-cdn.net/${workId}/${index}.webp?expires=1800000000`,name:`${String(index+1).padStart(3,'0')}.webp`,width:900,height:1350,expiresAt:1800000000}))};}
    if(url.pathname.includes('/works/')){const workId=url.pathname.split('/').slice(-1)[0];const item=catalog.find(item=>item.providerWorkId===workId)??catalog[0];return {publicationRevision:'demo-catalog',item:{...item,uploader:'Archive',category:1,updated:null,fileSize:null,rating:null,tagGroups:[{namespace:'artist',values:item.artists},{namespace:'language',values:['korean']}]}};}
    if(url.pathname.endsWith('/editions')){const group=url.pathname.split('/').slice(-2)[0];const item=catalog.find(item=>item.groupId===group)??catalog[0];return {publicationRevision:'demo-catalog',groupId:item.groupId,selectedProviderWorkId:null,items:[item],nextCursor:null,totalCount:1};}
  }
  if(url.pathname==='/v1/collections'){
    const showcase=url.searchParams.get('showcase')==='true',rating=url.searchParams.get('rating')??'all';
    const items=collections.filter(item=>item.type===url.searchParams.get('type')&&(!url.searchParams.get('q')||item.name.includes(url.searchParams.get('q')!))&&(showcase?item.showcase:rating==='all'||(rating==='unrated'?item.myScore==null:item.myScore===Number(rating))));
    const sort=url.searchParams.get('sort'),direction=url.searchParams.get('direction')==='asc'?1:-1;
    items.sort((a,b)=>showcase?(a.showcaseOrder??0)-(b.showcaseOrder??0):direction*(sort==='recent'?(a.createdAt??'').localeCompare(b.createdAt??''):sort==='media_date'?(a.year??0)-(b.year??0):a.name.localeCompare(b.name))||a.name.localeCompare(b.name));
    return {ready:true,filterVersion:1,revision:'demo-1',publishedAt:'2026-09-07T00:00:00Z',items,totalCount:items.length,nextCursor:null};
  }
  if(url.pathname.startsWith('/v1/collections/'))return {revision:'demo-1',item:collections.find(item=>item.id===url.pathname.split('/')[3])};
  if (url.pathname.includes('media-ticket')) {const id = url.pathname.split('/')[4]; return {url:assets.find(a => a.id === id)?.preview,expires_in:300};}
  if (url.pathname.endsWith('/classifications')) return {items:[{id:'game',name:'게임',parent_id:null,asset_count:120},{id:'wuthering',name:'명조',parent_id:'game',asset_count:48},{id:'reverse',name:'리버스',parent_id:'game',asset_count:52},{id:'zenless',name:'젠레스',parent_id:'game',asset_count:20},{id:'art',name:'일러스트',parent_id:null,asset_count:36},{id:'landscape',name:'풍경',parent_id:'art',asset_count:24},{id:'design',name:'디자인',parent_id:'art',asset_count:12}]};
  if (url.pathname.endsWith('/revisit')) return {bundles:[{kind:'date',title:'과거의 이날',items:assets.slice(0,8)},{kind:'creator',title:'다시 만난 작가',groups:[{creator_key:'bluealex1203',creator_name:'bluealex1203',asset_count:24,items:assets.slice(0,4)}]}]};
  if (url.pathname.includes('/captures')) return {captures:[]};
  const offset = Number(url.searchParams.get('cursor') ?? 0), limit = Number(url.searchParams.get('limit') ?? 40);
  const ranges:Record<string,[number,number]> = {game:[0,120],wuthering:[0,48],reverse:[48,100],zenless:[100,120],art:[0,36],landscape:[0,24],design:[24,36]};
  const range = ranges[url.searchParams.get('classification_id') ?? ''];
  const selected = range ? assets.slice(...range) : assets;
  // Match current server metadata: dimensions/preview arrive through thumbnails.
  return {items:selected.slice(offset,offset+limit).map(({preview,ratio,...asset}) => ({...asset,width:null,height:null})),has_more:offset+limit<selected.length,next_cursor:offset+limit<selected.length?String(offset+limit):null};
}
