import {useEffect,useRef,useState,useSyncExternalStore} from 'react';
import {FolderIcon,LinkIcon,RectangleStackIcon} from '@heroicons/react/24/outline';
import {AREA_ICONS} from '../src/shared/ui/areaIcons';
import {FIND_SCOPES} from '../src/shared/findModel';
import {FIND_WORK_TYPE_LABEL,MORE_KEYWORDS,SETTINGS_SECTION_LABELS,type NavigationEntry} from '../src/shared/findEntries';
import {isDayMemoNote} from '../src/notes/dayMemo';
import type {Note,NotesStore} from '../src/notes/store';
import {api} from './transport';
import {collectionPath,type CollectionSummary,type CollectionPage,type CollectionKind} from './collectionModel';
import {entryView,ancestorsOf,type Entry} from './libraryModel';
import {albumView,type AlbumTree} from './albumModel';
import type {View} from './types';
import {DESCRIPTION_TYPING_PAUSE_MS,cachedDescription,descriptionQueryReady,readDescription,type DescriptionAnswer} from './descriptionSearch';
import {artistName,searchValues,type LibraryArtist} from './artistsModel';

export const TABLET_FIND_SCOPES=FIND_SCOPES;
/** The tablet Settings groups Find can open directly (PC-only sections such as 라이브러리 or 고급 are not registered). */
export type TabletSettingsSection='connection'|'display'|'storage'|'vault';
export type FindDestination={kind:'work';id:string}|{kind:'artist';artist:LibraryArtist}|{kind:'note';id:string}|{kind:'place';view:View}|{kind:'shortcut';shortcut:'calendar'|'releases'|'links'}|{kind:'screen';screen:'home'|'assets'|'collections'|'catalog'|'notes'|'settings'}|{kind:'tool';id:string}|{kind:'settings';section:TabletSettingsSection};
export type TabletFindEntry=NavigationEntry&{destination:FindDestination;work?:{item:CollectionSummary;revision:string};assetId?:string;contentRating?:import("../src/shared/privacy/contentMask").ContentRating|null};

/**
 * Project titles only, including concealed and locked secret notes' public titles. `tools` are the More
 * destinations (전송, 휴지통, …) and `settingsSections` the Settings groups this tablet shows, both opened
 * like the PC palette's destinations and "설정 › …" entries; 링크 보관 and 설정 already have their own rows.
 */
export function tabletFindEntries({works,artists,notes,folders,albums,tools=[],settingsSections=[],navigate}:{works:{item:CollectionSummary;revision:string}[];artists:LibraryArtist[];notes:Pick<Note,'id'|'title'|'type'|'deleted'>[];folders:Entry[];albums:AlbumTree|null;tools?:NavigationEntry[];settingsSections?:readonly TabletSettingsSection[];navigate(destination:FindDestination):void}):TabletFindEntry[] {
  const entry=(id:string,group:NavigationEntry['group'],label:string,destination:FindDestination,extra:Partial<TabletFindEntry>={}):TabletFindEntry=>({id,group,label,icon:null,...extra,destination,run:()=>navigate(destination)});
  return [
    entry('release-calendar','go','발매 캘린더',{kind:'shortcut',shortcut:'calendar'},{icon:<AREA_ICONS.collections/>}),
    entry('new-releases','go','신간',{kind:'shortcut',shortcut:'releases'},{icon:<AREA_ICONS.collections/>}),
    entry('links','go','링크 보관',{kind:'shortcut',shortcut:'links'},{icon:<LinkIcon/>,keywords:MORE_KEYWORDS.links}),
    ...works.map(work=>entry(`work-${work.item.id}`,'work',work.item.name,{kind:'work',id:work.item.id},{workType:work.item.type,keywords:work.item.originalTitle?[work.item.originalTitle]:[],context:FIND_WORK_TYPE_LABEL[work.item.type],icon:<AREA_ICONS.collections/>,work})),
    ...artists.filter(artist=>!artist.hidden).map(artist=>entry(`artist-${artist.id}`,'artist',artistName(artist),{kind:'artist',artist},{count:artist.assetCount,keywords:searchValues(artist),icon:<AREA_ICONS.artists/>,avatar:true,assetId:artist.coverAssetIds[0],contentRating:artist.coverContentRatings?.[artist.coverAssetIds[0]]??null})),
    ...notes.filter(note=>!note.deleted&&note.type!=='ledger-month'&&!isDayMemoNote(note)).map(note=>entry(`note-${note.id}`,'note',note.title.trim()||'제목 없는 메모',{kind:'note',id:note.id},{icon:<AREA_ICONS.notes/>})),
    ...folders.map(folder=>entry(`place-folder-${folder.id}`,'place',folder.name,{kind:'place',view:entryView(folder)},{placeKind:folder.characterKind==='character'?'character':'folder',count:folder.asset_count,context:ancestorsOf(folders,folder.id).map(parent=>parent.name).join(' › ')||'폴더',icon:<FolderIcon/>})),
    ...(albums?.adopted?albums.albums.map(album=>entry(`place-album-${album.id}`,'place',album.name,{kind:'place',view:albumView(albums,album)},{context:'앨범',icon:<RectangleStackIcon/>})):[]),
    ...tools.filter(tool=>tool.id!=='links'&&tool.id!=='settings').map(tool=>entry(tool.id,tool.group,tool.label,{kind:'tool',id:tool.id},{icon:tool.icon,count:tool.count,activity:tool.activity,keywords:MORE_KEYWORDS[tool.id]})),
    ...settingsSections.map(section=>entry(`settings-${section}`,'settings',`설정 › ${SETTINGS_SECTION_LABELS[section]}`,{kind:'settings',section},{icon:<AREA_ICONS.settings/>})),
    ...([['home','홈',AREA_ICONS.home],['assets','에셋',AREA_ICONS.assets],['collections','컬렉션',AREA_ICONS.collections],['catalog','카탈로그',AREA_ICONS.manga],['notes','메모',AREA_ICONS.notes],['settings','설정',AREA_ICONS.settings]] as const).map(([screen,label,Icon])=>entry(`screen-${screen}`,'go',label,{kind:'screen',screen},{icon:<Icon/>})),
  ];
}

/** Reuse the tablet's existing paginated reads, once per sheet session, independent of typing. */
export function useFindWorks(open:boolean,endpoint:string) {
  const [works,setWorks]=useState<{endpoint:string;items:{item:CollectionSummary;revision:string}[]}|null>(null);
  const [loading,setLoading]=useState(false),[error,setError]=useState(''),[retry,setRetry]=useState(0);
  useEffect(()=>{
    if(!open)return;
    const controller=new AbortController();setLoading(true);setError('');
    const kinds:CollectionKind[]=['game','manga','movie','av'];
    void Promise.allSettled(kinds.map(async kind=>{
      const items:{item:CollectionSummary;revision:string}[]=[];const cursors=new Set<string>();let cursor:string|null=null;let revision:string|null|undefined;
      do {
        const page:CollectionPage=await api<CollectionPage>(collectionPath(kind,'',false,cursor),controller.signal);
        if(controller.signal.aborted)return [];
        if(!page.ready) return [];
        if(revision!==undefined&&page.revision!==revision)throw new Error('Changed collection publication');
        revision=page.revision;
        items.push(...page.items.map(item=>({item,revision:page.revision??''})));
        cursor=page.nextCursor;
        if(cursor&&cursors.has(cursor))throw new Error('Repeated collection cursor');
        if(cursor)cursors.add(cursor);
      }while(cursor&&!controller.signal.aborted);
      return items;
    })).then(results=>{
      if(controller.signal.aborted)return;
      setWorks(previous=>({endpoint,items:results.flatMap((result,index)=>result.status==='fulfilled'?result.value:previous?.endpoint===endpoint?previous.items.filter(({item})=>item.type===kinds[index]):[])}));setLoading(false);
      if(results.some(result=>result.status==='rejected'))setError('일부 작품을 불러오지 못했습니다.');
    });
    return()=>controller.abort();
  },[open,endpoint,retry]);
  return {works:works?.endpoint===endpoint?works.items:[],loading,error,retry:()=>setRetry(value=>value+1)};
}

export function useFindNoteTitles(open:boolean,store:NotesStore) {
  const state=useSyncExternalStore(store.subscribe,store.snapshot);
  useEffect(()=>{if(open)void store.load();},[open,store]);
  return {notes:(state.unlocked?state.notes:[]).map(({id,title,type,deleted})=>({id,title,type,deleted})),loading:!state.ready,error:state.error};
}

/**
 * 이미지 내용 strip state for the open sheet. `query` is committed text only (the note editor binding
 * commits after Hangul composition ends), and the server is asked once typing has paused. The last answer
 * stays as `shown` until the next one replaces it; a new sheet session starts without one.
 */
export function useDescriptionStrip({open,endpoint,query,enabled,count}:{open:boolean;endpoint:string;query:string;enabled:boolean;count:number}) {
  const [shown,setShown]=useState<DescriptionAnswer|null>(null),[busy,setBusy]=useState(false),[failed,setFailed]=useState(false);
  const latest=useRef<string|null>(null);
  const text=query.trim();
  const wanted=open&&enabled&&descriptionQueryReady(text)?text:null;
  useEffect(()=>{if(!open){latest.current=null;setShown(null);setFailed(false);setBusy(false);}},[open]);// no-flash-ok: the sheet is closed, nothing is painted
  useEffect(()=>{
    if(!wanted){latest.current=null;setBusy(false);return;}
    const cached=cachedDescription(endpoint,{query:wanted,force:false},count);
    if(cached){latest.current=wanted;setShown(cached);setFailed(false);setBusy(false);return;}
    let active=true;
    const timer=window.setTimeout(()=>{
      latest.current=wanted;setBusy(true);
      void readDescription(endpoint,{query:wanted,force:false},count).then(answer=>{
        if(!active)return;
        setShown(answer);setFailed(false);
      },()=>{if(active)setFailed(true);}).finally(()=>{if(latest.current===wanted)setBusy(false);});
    },DESCRIPTION_TYPING_PAUSE_MS);
    return()=>{active=false;window.clearTimeout(timer);};
  },[wanted,endpoint,count]);
  return {shown,busy,failed,asked:wanted!==null};
}
