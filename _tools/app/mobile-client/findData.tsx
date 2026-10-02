import {useEffect,useState,useSyncExternalStore} from 'react';
import {BookOpenIcon,FolderIcon,HomeIcon,PhotoIcon,PencilSquareIcon,RectangleStackIcon,Cog6ToothIcon,UserIcon} from '@heroicons/react/24/outline';
import {FIND_SCOPES} from '../src/shared/findModel';
import {FIND_WORK_TYPE_LABEL,type NavigationEntry} from '../src/shared/findEntries';
import type {Note,NotesStore} from '../src/notes/store';
import {api} from './transport';
import {collectionPath,type CollectionSummary,type CollectionPage,type CollectionKind} from './collectionModel';
import {entryView,ancestorsOf,type Entry} from './libraryModel';
import {albumView,type AlbumTree} from './albumModel';
import type {View} from './types';
import {artistName,searchValues,type LibraryArtist} from './artistsModel';

export const TABLET_FIND_SCOPES=FIND_SCOPES.filter(scope=>scope!=='명령');
export type FindDestination={kind:'work';id:string}|{kind:'artist';artist:LibraryArtist}|{kind:'note';id:string}|{kind:'place';view:View}|{kind:'screen';screen:'home'|'assets'|'collections'|'catalog'|'notes'|'settings'};
export type TabletFindEntry=NavigationEntry&{destination:FindDestination;work?:{item:CollectionSummary;revision:string};assetId?:string};

/** Project titles only, including concealed and locked secret notes' public titles. */
export function tabletFindEntries({works,artists,notes,folders,albums,navigate}:{works:{item:CollectionSummary;revision:string}[];artists:LibraryArtist[];notes:Pick<Note,'id'|'title'|'type'|'deleted'>[];folders:Entry[];albums:AlbumTree|null;navigate(destination:FindDestination):void}):TabletFindEntry[] {
  const entry=(id:string,group:NavigationEntry['group'],label:string,destination:FindDestination,extra:Partial<TabletFindEntry>={}):TabletFindEntry=>({id,group,label,icon:null,...extra,destination,run:()=>navigate(destination)});
  return [
    ...works.map(work=>entry(`work-${work.item.id}`,'work',work.item.name,{kind:'work',id:work.item.id},{keywords:work.item.originalTitle?[work.item.originalTitle]:[],context:FIND_WORK_TYPE_LABEL[work.item.type],icon:<BookOpenIcon/>,work})),
    ...artists.filter(artist=>!artist.hidden).map(artist=>entry(`artist-${artist.id}`,'artist',artistName(artist),{kind:'artist',artist},{keywords:searchValues(artist),icon:<UserIcon/>,avatar:true,assetId:artist.coverAssetIds[0]})),
    ...notes.filter(note=>!note.deleted&&note.type!=='ledger-month').map(note=>entry(`note-${note.id}`,'note',note.title.trim()||'제목 없는 메모',{kind:'note',id:note.id},{icon:<PencilSquareIcon/>})),
    ...folders.map(folder=>entry(`place-folder-${folder.id}`,'place',folder.name,{kind:'place',view:entryView(folder)},{context:ancestorsOf(folders,folder.id).map(parent=>parent.name).join(' › ')||'폴더',icon:<FolderIcon/>})),
    ...(albums?.adopted?albums.albums.map(album=>entry(`place-album-${album.id}`,'place',album.name,{kind:'place',view:albumView(albums,album)},{context:'앨범',icon:<RectangleStackIcon/>})):[]),
    ...([['home','홈',HomeIcon],['assets','에셋',PhotoIcon],['collections','컬렉션',RectangleStackIcon],['catalog','카탈로그',BookOpenIcon],['notes','메모',PencilSquareIcon],['settings','설정',Cog6ToothIcon]] as const).map(([screen,label,Icon])=>entry(`screen-${screen}`,'go',label,{kind:'screen',screen},{icon:<Icon/>})),
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
