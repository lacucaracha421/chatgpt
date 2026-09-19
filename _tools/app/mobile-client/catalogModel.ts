export type CatalogQuery = {provider:'kHentai';language:'all'|'korean'|'japanese';text:string;category:number|null;sort:'latest'|'views'|'hotDay'|'hotWeek'|'hotMonth';scope:'all'|'bookmarked';revealBlocked:boolean;limit:number};
export const DEFAULT_CATALOG_QUERY:CatalogQuery={provider:'kHentai',language:'korean',text:'',category:null,sort:'hotDay',scope:'all',revealBlocked:false,limit:40};
export type CatalogWork = {provider:'kHentai';providerWorkId:string;title:string;titleJpn:string|null;thumbnailUrl:string|null;bookmarked:boolean;fileCount:number;views:number;posted:number;artists:string[];series:string[]};
export type CatalogItem = CatalogWork & {groupId:string;versionCount:number;hasBookmarkedVersion:boolean};
export type CatalogPage = {ready:boolean;publicationRevision:string|null;publishedAt:string|null;items:CatalogItem[];nextCursor:string|null;context:string|null;countToken:string|null;totalCount:number|null;countStatus:'pending'|'ready'|'unavailable'};
export type CatalogDetail = {provider:'kHentai';providerWorkId:string;title:string;titleJpn:string|null;thumbnailUrl:string|null;uploader:string|null;category:number|null;posted:number|null;updated:number|null;fileCount:number;fileSize:number|null;rating:number|null;views:number;bookmarked:boolean;bookmarkRevision?:number;tagGroups:{namespace:string;values:string[];labels?:Record<string,string>}[]};
export type CatalogEditions = {publicationRevision:string;groupId:string;selectedProviderWorkId:string|null;items:CatalogWork[];nextCursor:string|null;totalCount:number};
export type CatalogReaderPage = {index:number;url:string;name:string|null;width:number|null;height:number|null;expiresAt:number|null};
export type CatalogReaderManifest = {publicationRevision:string;provider:'kHentai';providerWorkId:string;pages:CatalogReaderPage[];manifestExpiresAt:number|null};
/**
 * The selector's category is an orthogonal filter, not part of the user's query
 * text. It never appears as a URL parameter because the mobile search route
 * rejects unknown parameters; it is folded into the `text` the server already
 * understands, with the user's own expression parenthesised so operator
 * precedence cannot bind across it. When no category is selected the text is
 * sent byte-for-byte, so an advanced query the user typed is never rewritten.
 */
export function catalogWireText(query:Pick<CatalogQuery,'text'|'category'>){
  if(query.category===null||query.category===undefined)return query.text;
  return query.text.trim()?`(${query.text}) category:${query.category}`:`category:${query.category}`;
}
export function catalogPath(query:CatalogQuery,cursor:string|null){
  if(cursor)return `/v1/mobile-catalog/search?${new URLSearchParams({cursor})}`;
  const params=new URLSearchParams(Object.entries(query).filter(([key])=>key!=='category').map(([key,value])=>[key,String(value)]));
  params.set('text',catalogWireText(query));
  return `/v1/mobile-catalog/search?${params}`;
}
export function catalogDetailPath(item:Pick<CatalogWork,'provider'|'providerWorkId'>,context:string){return `/v1/mobile-catalog/works/${item.provider}/${encodeURIComponent(item.providerWorkId)}?${new URLSearchParams({context})}`;}
export function catalogEditionsPath(groupId:string,context:string,cursor:string|null){return `/v1/mobile-catalog/groups/kHentai/${encodeURIComponent(groupId)}/editions?${new URLSearchParams({context,...(cursor?{cursor}:{})})}`;}
export function catalogReaderPath(item:Pick<CatalogWork,'provider'|'providerWorkId'>,context:string){return `/v1/mobile-catalog/works/${item.provider}/${encodeURIComponent(item.providerWorkId)}/reader?${new URLSearchParams({context})}`;}
export function catalogTagQuery(namespace:string,value:string){return `${namespace}:"${value.replace(/\\/g,'\\\\').replace(/"/g,'\\"')}"`;}
export function catalogError(reason:unknown){
  const status=(reason as {status?:number})?.status;
  if(status===404)return '서버에 모바일 카탈로그 기능이 필요합니다.';
  if(status===409)return '카탈로그가 갱신되었거나 이 목록의 유효기간이 끝났습니다. 새로고침해 주세요.';
  if(status===422)return '검색식을 확인해 주세요.';
  if(status===503)return '검색 시간이 길어지고 있습니다. 조건을 좁히거나 다시 시도해 주세요.';
  return '';
}
