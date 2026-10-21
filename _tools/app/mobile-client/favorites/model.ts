import type {CharacterTarget} from '../../src/characters/api';
import type {ClassificationEntry,FavoriteEntry} from '../../src/library/types';
import type {CharacterIndex,CharacterNode} from '../characterModel';
import type {Classification} from '../types';
export {representativeAsset,birthdayDays,containerId,favoriteScopes,reorderCommand} from '../../src/collections/favorites/model';

/** Translate wire names once; the PC model remains the owner of the display rules. */
export function favoriteFolders(folders:Classification[]):ClassificationEntry[] {
  return folders.map(folder=>({id:folder.id,name:folder.name,parentId:folder.parent_id,
    kind:folder.kind??'tag',isContainer:folder.kind==='root',iconKey:folder.icon_key??null,colorKey:folder.color_key??null}));
}
export function favoriteTargets(index:CharacterIndex):CharacterTarget[] {
  return index.nodes.filter(node=>node.kind==='character'&&node.role!=='extras').map(node=>({
    id:node.sourceId,seriesClassificationId:node.seriesId,linkedClassificationId:null,
    displayName:node.name,description:node.description,thumbnailAssetId:node.thumbnailAssetId,
    enabled:true,manualOnly:node.manualOnly,revision:0,references:[],ready:true,fingerprint:'',
  }));
}
export const favoriteNode=(index:CharacterIndex,id:string):CharacterNode|undefined=>index.nodes.find(node=>node.id===`character:${id}`&&node.kind==='character'&&node.role!=='extras');
export const visibleFavorites=(entries:FavoriteEntry[],index:CharacterIndex)=>entries.filter(entry=>favoriteNode(index,entry.characterId));
