import {api} from './transport';
import type {AlbumTree,NativeAlbum} from './albumModel';
import {batches} from './batchCommands';

export const ALBUM_TREE_CHANGED = 'lakomics-album-tree-changed';
export type AuthorityAlbum = NativeAlbum & {entityRevision:number;deleted:boolean};
type Baseline = {libraryId:string;epoch:number;snapshotCursor:number;listGeneration?:string;items:AuthorityAlbum[];hasMore:boolean;nextAfter:string|null;likesAlbumId:string|null};
export type AlbumSnapshot = {albums:AuthorityAlbum[];likesAlbumId:string|null};

/** Pin every page to one authority snapshot; never guess an entity revision from the replica. */
export async function readAlbumSnapshot(tree:AlbumTree,signal?:AbortSignal):Promise<AlbumSnapshot> {
  if(!tree.adopted||!tree.libraryId||tree.epoch===null)throw new Error('앨범 동기화가 준비된 뒤 편집할 수 있습니다.');
  const albums:AuthorityAlbum[]=[];
  let after:string|null=null,snapshot:number|undefined,listGeneration:string|undefined,likesAlbumId:string|null=null;
  do {
    const path:string=`/v1/albums/baseline?libraryId=${encodeURIComponent(tree.libraryId)}&epoch=${tree.epoch}&section=albums&limit=200${snapshot===undefined?'':`&snapshot=${snapshot}`}${after?`&after=${encodeURIComponent(after)}`:''}`;
    const page:Baseline=await api<Baseline>(path,signal);
    if(page.libraryId!==tree.libraryId||page.epoch!==tree.epoch||!Array.isArray(page.items)||!Number.isInteger(page.snapshotCursor))throw new Error('앨범 목록을 다시 불러와 주세요.');
    if(snapshot!==undefined&&snapshot!==page.snapshotCursor)throw new Error('앨범 목록이 변경되었습니다. 다시 시도해 주세요.');
    if(snapshot!==undefined&&listGeneration!==page.listGeneration)throw new Error('앨범 목록이 변경되었습니다. 다시 시도해 주세요.');
    listGeneration=page.listGeneration;
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

export type AlbumBatchError = {code?:string;status?:number;message?:string;current?:unknown};
/** One command's outcome from `PUT /v1/albums/commands/batch`; `failed` means the request itself did not complete. */
export type AlbumBatchOutcome = {
  operationId:string;
  status:'applied'|'noop'|'conflict'|'rejected'|'failed';
  changed:boolean;
  changeSequence:number|null;
  membership?:unknown;
  album?:{id:string}|null;
  error?:AlbumBatchError;
};
type AlbumBatchReply = {results:AlbumBatchOutcome[]};

/**
 * Send commands in requests of at most 100 and return one outcome per command, in order.
 * A command refused by the server comes back as `conflict`/`rejected` on its own entry; a request that never
 * completed marks only its own commands `failed`, so earlier chunks keep their results.
 */
export async function albumBatchCommand(tree:AlbumTree,commands:Record<string,unknown>[]):Promise<AlbumBatchOutcome[]> {
  if(!tree.adopted||!tree.libraryId||tree.epoch===null)throw new Error('앨범 동기화가 준비된 뒤 편집할 수 있습니다.');
  const outcomes:AlbumBatchOutcome[]=[];
  for(const chunk of batches(commands.map(command=>({...command,operationId:crypto.randomUUID()})))) {
    try {
      const reply=await api<AlbumBatchReply>('/v1/albums/commands/batch',undefined,{libraryId:tree.libraryId,epoch:tree.epoch,contractVersion:1,batchId:crypto.randomUUID(),commands:chunk},'PUT');
      if(!Array.isArray(reply?.results)||reply.results.length!==chunk.length||reply.results.some((item,index)=>item.operationId!==chunk[index].operationId))throw new Error('앨범 일괄 응답이 올바르지 않습니다. 다시 시도해 주세요.');
      outcomes.push(...reply.results);
    } catch(reason) {
      const message=reason instanceof Error?reason.message:String(reason);
      outcomes.push(...chunk.map(command=>({operationId:command.operationId,status:'failed' as const,changed:false,changeSequence:null,error:{message}})));
    }
  }
  return outcomes;
}

export function publishAlbumTree(tree:AlbumTree,albums:NativeAlbum[]) {
  window.dispatchEvent(new CustomEvent<AlbumTree>(ALBUM_TREE_CHANGED,{detail:{...tree,albums}}));
}
