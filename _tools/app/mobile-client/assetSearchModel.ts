import {combineAssetSearchChoices,assetSearchKey,ASSET_SEARCH_GROUPS,type AssetSearchIdentity,type AssetSearchName} from '../src/assets/assetSearch';
import {entryView,type Entry} from './libraryModel';
import {albumView,type AlbumTree} from './albumModel';
import {artistName,assetsFromIds,type LibraryArtist} from './artistsModel';
import {characterCovers} from './FolderCards';
import type {CharacterIndex} from './characterModel';
import type {Asset,View} from './types';
export type AssetSuggestion = AssetSearchName & {cover?:Asset} & ({kind:'tag'}|{kind:'artist';artist:LibraryArtist}|{kind:'folder'|'character'|'album';view:View});
export type AssetSearchChip = {type:'scope';item:AssetSuggestion}|{type:'tag';id:string;name:string};
export function assetSuggestions(entries:Entry[],characters:CharacterIndex|undefined,tree:AlbumTree|null,artists:LibraryArtist[]):AssetSuggestion[] {
  const result:AssetSuggestion[]=entries.map(entry=>({kind:entry.characterKind?'character':'folder',id:entry.id,name:entry.name,count:entry.asset_count,view:entryView(entry),cover:characterCovers(entry,characters)[0]}));
  if(tree?.adopted&&tree.libraryId&&tree.epoch!==null)for(const album of tree.albums)result.push({kind:'album',id:album.id,name:album.name,count:album.assetCount,view:albumView(tree,album)});
  for(const artist of artists)result.push({kind:'artist',id:artist.id,name:artistName(artist),count:artist.assetCount,artist,cover:assetsFromIds(artist.coverAssetIds,artist.coverContentRatings)[0]});
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
    }).slice(0,8).map(({kind,id,name}:AssetSearchIdentity)=>({kind,id,...(kind==='tag'&&typeof name==='string'?{name}:{})}));
  }catch{return [];}
}
export function writeAssetSearchRecents(endpoint:string,items:AssetSearchIdentity[]) {
  try{localStorage.setItem(RECENT_KEY,JSON.stringify({endpoint,items}));}catch{/* Optional device history. */}
}

export function chipName(chip:AssetSearchChip):AssetSearchName {
  return chip.type==='tag'?{kind:'tag',id:chip.id,name:chip.name}:chip.item;
}
export function searchChip(item:AssetSuggestion):AssetSearchChip {
  return item.kind==='tag'?{type:'tag',id:item.id,name:item.name}:{type:'scope',item};
}
export function addSearchChip(chips:AssetSearchChip[],item:AssetSuggestion) {
  const items=chips.map(chip=>chip.type==='tag'?{kind:'tag' as const,id:chip.id,name:chip.name}:chip.item);
  return combineAssetSearchChoices<AssetSuggestion>(items,item).map(searchChip);
}
export function searchView(chips:AssetSearchChip[]):View {
  const scope=chips.find(chip=>chip.type==='scope'&&(chip.item.kind==='album'||chip.item.kind==='character'));
  const folders=chips.filter(chip=>chip.type==='scope'&&chip.item.kind==='folder');
  const selected=scope??(folders.length===1?folders[0]:undefined);
  const base=selected?.type==='scope'&&selected.item.kind!=='artist'&&selected.item.kind!=='tag'?selected.item.view:{tab:'library' as const,title:'에셋'};
  return {...base,search:chips.map(chipName)};
}
export function removeViewSearch(view:View,removed:readonly AssetSearchName[]):View {
  const search=(view.search??[]).filter(chip=>!removed.some(item=>assetSearchKey(item)===assetSearchKey(chip)));
  return searchView(viewSearchChips({...view,search}));
}
/** Probe identities independently: a generic 422 must never discard valid neighbouring chips. */
export async function invalidSearchChoices(chips:readonly AssetSearchName[],read:(chip:AssetSearchName)=>Promise<unknown>,signal:AbortSignal) {
  const results=await Promise.all(chips.map(async chip=>{
    try{await read(chip);return null;}catch(error){return !signal.aborted&&(error as {status?:number})?.status===422?chip:null;}
  }));
  return signal.aborted?[]:results.filter((chip):chip is AssetSearchName=>chip!==null);
}

/** Scope suggestions retain their destination on the committed View, including after Back/cache restore. */
export function viewSearchChips(view:View):AssetSearchChip[] {
  return (view.search??[]).map(item=>searchChip(item as AssetSuggestion));
}
