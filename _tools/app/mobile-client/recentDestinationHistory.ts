import {createContext,useContext,useEffect,useRef,useState} from 'react';

/**
 * Where the user recently put images (TABLET-STRUCT-001 C): the ids of folders and albums, newest first.
 * Folders come from the tablet's recent-folder history; albums keep their own per-device history here.
 * The sheets draw the chips from these ids and the tree they already hold, so a deleted folder or
 * album simply drops out and a rename follows by id.
 */
export type RecentDestinationIds={folders:readonly string[];albums:readonly string[]};
const NONE:RecentDestinationIds={folders:[],albums:[]};
export const RecentDestinationsContext=createContext<RecentDestinationIds>(NONE);
export const useRecentDestinationIds=()=>useContext(RecentDestinationsContext);

/** The ids as they were when the sheet opened (a sheet that mounts open passes `open`): the row must not reshuffle under a tap or its done state. */
export function useFrozenIds(ids:readonly string[],open:boolean):readonly string[]{
  const frozen=useRef(ids);
  if(!open)frozen.current=ids;
  return frozen.current;
}

export const RECENT_ALBUM_LIMIT=8;
export const ALBUM_FILLED_EVENT='lakomics-album-filled';
/** Images were added to an album from a sheet or the viewer. */
export const announceAlbumFilled=(albumId:string)=>window.dispatchEvent(new CustomEvent(ALBUM_FILLED_EVENT,{detail:{albumId}}));
export const recentAlbumsKey=(scope:string)=>`lakomics.mobile.assetRecentAlbums:${encodeURIComponent(scope)}`;

export function readRecentAlbums(scope:string):string[]{
  try{
    const value:unknown=JSON.parse(localStorage.getItem(recentAlbumsKey(scope))??'[]');
    return Array.isArray(value)?value.filter((id):id is string=>typeof id==='string').slice(0,RECENT_ALBUM_LIMIT):[];
  }catch{return [];}
}
export const rememberRecentAlbum=(ids:readonly string[],id:string)=>[id,...ids.filter(item=>item!==id)].slice(0,RECENT_ALBUM_LIMIT);

/** The tablet's own recent albums for one library; nothing is synced. */
export function useTabletRecentAlbums(scope:string):readonly string[]{
  const [ids,setIds]=useState(()=>readRecentAlbums(scope));
  const current=useRef({scope,ids});
  current.current={scope,ids};
  useEffect(()=>{setIds(readRecentAlbums(scope));},[scope]);
  useEffect(()=>{
    const filled=(event:Event)=>{
      const id=(event as CustomEvent<{albumId?:string}>).detail?.albumId;
      if(!id)return;
      const next=rememberRecentAlbum(current.current.ids,id);
      current.current.ids=next;
      setIds(next);
      try{localStorage.setItem(recentAlbumsKey(current.current.scope),JSON.stringify(next));}catch{/* Optional device history. */}
    };
    window.addEventListener(ALBUM_FILLED_EVENT,filled);
    return()=>window.removeEventListener(ALBUM_FILLED_EVENT,filled);
  },[]);
  return ids;
}
