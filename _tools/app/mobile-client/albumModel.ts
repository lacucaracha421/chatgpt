import {normalizePage} from './model';
import type {Asset, Page, View} from './types';

export interface NativeAlbum { id:string; name:string; parentId:string|null; iconKey:string|null; colorKey:string|null; assetCount?:number }
export interface AlbumTree { adopted:boolean; libraryId:string|null; epoch:number|null; code:string; albums:NativeAlbum[] }
export interface AlbumAssetPage { items:Asset[]; hasMore:boolean; nextCursor:string|null; filterVersion?:unknown }
/** Preserve the Album route's camelCase envelope and the agreed filterVersion wire field. */
export function albumPage(value:AlbumAssetPage):Page {
  return normalizePage({items:value.items,has_more:value.hasMore,next_cursor:value.nextCursor,filterVersion:value.filterVersion});
}
export function albumAncestors(albums:NativeAlbum[],id:string):NativeAlbum[] {
  const byId=new Map(albums.map(album=>[album.id,album])),path:NativeAlbum[]=[],seen=new Set<string>([id]);
  let current=byId.get(id)?.parentId;
  while(current&&!seen.has(current)) {
    seen.add(current);
    const album=byId.get(current);if(!album)break;
    path.unshift(album);current=album.parentId;
  }
  return path;
}
export function albumPath(albums:NativeAlbum[],id:string):string {
  return [...albumAncestors(albums,id),...albums.filter(album=>album.id===id)].map(album=>album.name).join(' / ');
}
export function albumView(tree:AlbumTree,album:NativeAlbum):View {
  if(!tree.adopted||!tree.libraryId||tree.epoch===null)throw new Error('앨범 권위가 아직 활성화되지 않았습니다.');
  return {tab:'library',title:album.name,album:{id:album.id,libraryId:tree.libraryId,epoch:tree.epoch}};
}
