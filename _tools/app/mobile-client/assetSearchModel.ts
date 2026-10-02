import {assetSearchKey,ASSET_SEARCH_GROUPS,type AssetSearchIdentity,type AssetSearchName} from '../src/assets/assetSearch';
import {entryView,type Entry} from './libraryModel';
import {albumView,type AlbumTree} from './albumModel';
import {artistName,assetFromId,type LibraryArtist} from './artistsModel';
import {characterCovers} from './FolderCards';
import type {CharacterIndex} from './characterModel';
import type {Asset,View} from './types';
export type AssetSuggestion = AssetSearchName & {cover?:Asset} & ({kind:'artist';artist:LibraryArtist}|{kind:'folder'|'character'|'album';view:View});
// Tags are state-only until the server's later multi-chip contract is available.
export type AssetSearchChip = {type:'scope';item:AssetSuggestion}|{type:'tag';id:string;name:string};
export function assetSuggestions(entries:Entry[],characters:CharacterIndex|undefined,tree:AlbumTree|null,artists:LibraryArtist[]):AssetSuggestion[] {
  const result:AssetSuggestion[]=entries.map(entry=>({kind:entry.characterKind?'character':'folder',id:entry.id,name:entry.name,count:entry.asset_count,view:entryView(entry),cover:characterCovers(entry,characters)[0]}));
  if(tree?.adopted&&tree.libraryId&&tree.epoch!==null)for(const album of tree.albums)result.push({kind:'album',id:album.id,name:album.name,count:album.assetCount,view:albumView(tree,album)});
  for(const artist of artists)result.push({kind:'artist',id:artist.id,name:artistName(artist),count:artist.assetCount,artist,cover:artist.coverAssetIds[0]?assetFromId(artist.coverAssetIds[0]):undefined});
  return result;
}
const RECENT_KEY='lakomics.mobile.assetSearch.recents';
export function readAssetSearchRecents(endpoint:string):AssetSearchIdentity[] {
  try {
    const stored=JSON.parse(localStorage.getItem(RECENT_KEY)??'null');
    if(stored?.endpoint!==endpoint||!Array.isArray(stored.items))return [];
    const seen=new Set<string>();
    return stored.items.filter((item:AssetSearchIdentity)=>{
      if(!item||typeof item.id!=='string'||!ASSET_SEARCH_GROUPS.some(group=>group.kind===item.kind))return false;
      const key=assetSearchKey(item);if(seen.has(key))return false;seen.add(key);return true;
    }).slice(0,8).map(({kind,id}:AssetSearchIdentity)=>({kind,id}));
  }catch{return [];}
}
export function writeAssetSearchRecents(endpoint:string,items:AssetSearchIdentity[]) {
  try{localStorage.setItem(RECENT_KEY,JSON.stringify({endpoint,items}));}catch{/* Optional device history. */}
}
