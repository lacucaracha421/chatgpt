import type {CharacterTarget} from '../../src/characters/api';
import type {ClassificationEntry,FavoriteEntry} from '../../src/library/types';
import type {CharacterIndex,CharacterNode} from '../characterModel';
import type {Classification} from '../types';
import {favoriteTargets as projectTargets,isManualFavorite} from '../../src/collections/favorites/model';
export {representativeAsset,birthdayDays,containerId,favoriteScopes,reorderCommand,isManualFavorite,createFavoriteCommand,linkFavoriteCommand} from '../../src/collections/favorites/model';

/** Translate wire names once; the PC model remains the owner of the display rules. */
export function favoriteFolders(folders:Classification[]):ClassificationEntry[] {
  return folders.map(folder=>({id:folder.id,name:folder.name,parentId:folder.parent_id,
    kind:folder.kind??'tag',isContainer:folder.kind==='root',iconKey:folder.icon_key??null,colorKey:folder.color_key??null}));
}
/** Character targets from the tablet index; `entries` narrows them to the favourites through the PC rule. */
export function indexFavoriteTargets(index:CharacterIndex,entries?:FavoriteEntry[]):CharacterTarget[] {
  const targets=index.nodes.filter(node=>index.ready&&node.kind==='character'&&node.role!=='extras').map(node=>({
    id:node.sourceId,seriesClassificationId:node.seriesId,linkedClassificationId:null,
    displayName:node.name,description:node.description,thumbnailAssetId:node.thumbnailAssetId,
    enabled:true,manualOnly:node.manualOnly,revision:0,references:[],ready:true,fingerprint:'',
  }));
  return entries?projectTargets(entries,targets):targets;
}
export const favoriteNode=(index:CharacterIndex,id:string,entry?:FavoriteEntry):CharacterNode|undefined=>isManualFavorite(id)&&entry?{
  id:`character:${id}`,sourceId:id,kind:'character',seriesId:'',parentId:null,name:entry.name??'',description:'',thumbnailAssetId:null,manualOnly:true,
}:index.ready?index.nodes.find(node=>node.id===`character:${id}`&&node.kind==='character'&&node.role!=='extras'):undefined;
export const visibleFavorites=(entries:FavoriteEntry[],index:CharacterIndex)=>entries.filter(entry=>favoriteNode(index,entry.characterId,entry));
