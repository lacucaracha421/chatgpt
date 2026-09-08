export type CatalogQuery = {provider:'kHentai';language:'all'|'korean'|'japanese';text:string;sort:'latest'|'views'|'hotDay'|'hotWeek'|'hotMonth';scope:'all'|'bookmarked';revealBlocked:boolean;limit:number};
export const DEFAULT_CATALOG_QUERY:CatalogQuery={provider:'kHentai',language:'korean',text:'',sort:'latest',scope:'all',revealBlocked:false,limit:40};
export type CatalogWork = {provider:'kHentai';providerWorkId:string;title:string;titleJpn:string|null;thumbnailUrl:string|null;bookmarked:boolean;fileCount:number;views:number;posted:number;artists:string[];series:string[]};
export type CatalogItem = CatalogWork & {groupId:string;versionCount:number;hasBookmarkedVersion:boolean};
export type CatalogPage = {ready:boolean;publicationRevision:string|null;publishedAt:string|null;items:CatalogItem[];nextCursor:string|null;context:string|null;countToken:string|null;totalCount:number|null;countStatus:'pending'|'ready'|'unavailable'};
export type CatalogDetail = {provider:'kHentai';providerWorkId:string;title:string;titleJpn:string|null;thumbnailUrl:string|null;uploader:string|null;category:number|null;posted:number|null;updated:number|null;fileCount:number;fileSize:number|null;rating:number|null;views:number;bookmarked:boolean;tagGroups:{namespace:string;values:string[];labels?:Record<string,string>}[]};
export type CatalogEditions = {publicationRevision:string;groupId:string;selectedProviderWorkId:string|null;items:CatalogWork[];nextCursor:string|null;totalCount:number};
export function catalogPath(query:CatalogQuery,cursor:string|null){
  const params=cursor?new URLSearchParams({cursor}):new URLSearchParams(Object.entries(query).map(([key,value])=>[key,String(value)]));
  return `/v1/mobile-catalog/search?${params}`;
}
export function catalogDetailPath(item:Pick<CatalogWork,'provider'|'providerWorkId'>,context:string){return `/v1/mobile-catalog/works/${item.provider}/${encodeURIComponent(item.providerWorkId)}?${new URLSearchParams({context})}`;}
export function catalogEditionsPath(groupId:string,context:string,cursor:string|null){return `/v1/mobile-catalog/groups/kHentai/${encodeURIComponent(groupId)}/editions?${new URLSearchParams({context,...(cursor?{cursor}:{})})}`;}
export function catalogTagQuery(namespace:string,value:string){return `${namespace}:"${value.replace(/\\/g,'\\\\').replace(/"/g,'\\"')}"`;}
export function catalogError(reason:unknown){
  const status=(reason as {status?:number})?.status;
  if(status===404)return '서버에 모바일 카탈로그 기능이 필요합니다.';
  if(status===409)return '카탈로그가 갱신되었거나 이 목록의 유효기간이 끝났습니다. 새로고침해 주세요.';
  if(status===422)return '검색식을 확인해 주세요.';
  if(status===503)return '검색 시간이 길어지고 있습니다. 조건을 좁히거나 다시 시도해 주세요.';
  return '';
}
