import {api} from '../transport';
import type {FavoriteCharacters, FavoriteCommand} from '../../src/library/types';

const PATH='/v1/library/favorite-characters';
export const FAVORITES_SIGNAL='favoriteCharacters';

function read(value:unknown):FavoriteCharacters {
  const reply=value as FavoriteCharacters|null;
  if(!reply||reply.version!==1||!Number.isSafeInteger(reply.revision)||!Array.isArray(reply.entries))
    throw new Error('캐릭터 목록을 불러오지 못했습니다.');
  return reply;
}
export const loadFavorites=(signal?:AbortSignal)=>api<unknown>(PATH,signal).then(read);
export const changeFavorites=(commands:FavoriteCommand[])=>api<unknown>(PATH,undefined,{commands},'POST').then(read);
