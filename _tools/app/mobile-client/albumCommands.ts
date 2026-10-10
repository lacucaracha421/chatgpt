import {api} from './transport';
import type {AlbumTree,NativeAlbum} from './albumModel';

export const ALBUM_TREE_CHANGED = 'lakomics-album-tree-changed';
export type AuthorityAlbum = NativeAlbum & {entityRevision:number;deleted:boolean};
type Baseline = {libraryId:string;epoch:number;snapshotCursor:number;items:AuthorityAlbum[];hasMore:boolean;nextAfter:string|null;likesAlbumId:string|null};
export type AlbumSnapshot = {albums:AuthorityAlbum[];likesAlbumId:string|null};

/** Pin every page to one authority snapshot; never guess an entity revision from the replica. */
export async function readAlbumSnapshot(tree:AlbumTree,signal?:AbortSignal):Promise<AlbumSnapshot> {
  if(!tree.adopted||!tree.libraryId||tree.epoch===null)throw new Error('앨범 동기화가 준비된 뒤 편집할 수 있습니다.');
  const albums:AuthorityAlbum[]=[];
  let after:string|null=null,snapshot:number|undefined,likesAlbumId:string|null=null;
  do {
    const path:string=`/v1/albums/baseline?libraryId=${encodeURIComponent(tree.libraryId)}&epoch=${tree.epoch}&section=albums&limit=200${snapshot===undefined?'':`&snapshot=${snapshot}`}${after?`&after=${encodeURIComponent(after)}`:''}`;
    const page:Baseline=await api<Baseline>(path,signal);
    if(page.libraryId!==tree.libraryId||page.epoch!==tree.epoch||!Array.isArray(page.items)||!Number.isInteger(page.snapshotCursor))throw new Error('앨범 목록을 다시 불러와 주세요.');
    if(snapshot!==undefined&&snapshot!==page.snapshotCursor)throw new Error('앨범 목록이 변경되었습니다. 다시 시도해 주세요.');
    snapshot=page.snapshotCursor;likesAlbumId=page.likesAlbumId;
    albums.push(...page.items);
    if(page.hasMore&&(!page.nextAfter||page.nextAfter===after))throw new Error('앨범 목록을 다시 불러와 주세요.');
    after=page.hasMore?page.nextAfter:null;
  } while(after);
  return {albums:albums.filter(album=>!album.deleted),likesAlbumId};
}

export function albumCommand<T>(tree:AlbumTree,commandType:string,fields:Record<string,unknown>):Promise<T> {
  if(!tree.adopted||!tree.libraryId||tree.epoch===null)throw new Error('앨범 동기화가 준비된 뒤 편집할 수 있습니다.');
  return api<T>('/v1/albums/commands',undefined,{libraryId:tree.libraryId,epoch:tree.epoch,contractVersion:1,operationId:crypto.randomUUID(),commandType,...fields},'PUT');
}

export function publishAlbumTree(tree:AlbumTree,albums:NativeAlbum[]) {
  window.dispatchEvent(new CustomEvent<AlbumTree>(ALBUM_TREE_CHANGED,{detail:{...tree,albums}}));
}
