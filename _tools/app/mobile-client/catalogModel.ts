/**
 * Wire identity for the mobile catalog read API.
 *
 * Device-specific filters (`categories`, `excludedTags`) are additive read
 * parameters: `null` categories means the list is unrestricted, an explicit
 * empty array admits nothing, and the excluded pairs are exact
 * `(namespace,value)` matches. The user's own query text is never rewritten —
 * the selector used to be folded into `text`, which silently changed what an
 * advanced expression meant. `searchMode=mobile` is only sent when the server
 * advertises the capability, so an older server keeps its exact old semantics
 * instead of receiving a parameter it rejects.
 */
export type CatalogQuery = {provider:'kHentai';language:'all'|'korean'|'japanese';text:string;categories:number[]|null;excludedTags:CatalogExcludedTag[];sort:'latest'|'views'|'hotDay'|'hotWeek'|'hotMonth';scope:'all'|'bookmarked';revealBlocked:boolean;limit:number};
export type CatalogExcludedTag = {namespace:string;value:string};
export const DEFAULT_CATALOG_QUERY:CatalogQuery={provider:'kHentai',language:'korean',text:'',categories:null,excludedTags:[],sort:'hotDay',scope:'all',revealBlocked:false,limit:40};
export type CatalogWork = {provider:'kHentai';providerWorkId:string;title:string;titleJpn:string|null;thumbnailUrl:string|null;bookmarked:boolean;fileCount:number;views:number;posted:number;artists:string[];series:string[]};
export type CatalogItem = CatalogWork & {groupId:string;versionCount:number;hasBookmarkedVersion:boolean};
export type CatalogPage = {ready:boolean;publicationRevision:string|null;publishedAt:string|null;items:CatalogItem[];nextCursor:string|null;context:string|null;countToken:string|null;totalCount:number|null;countStatus:'pending'|'ready'|'unavailable'};
export type CatalogDetail = {provider:'kHentai';providerWorkId:string;title:string;titleJpn:string|null;thumbnailUrl:string|null;uploader:string|null;category:number|null;posted:number|null;updated:number|null;fileCount:number;fileSize:number|null;rating:number|null;views:number;bookmarked:boolean;bookmarkRevision?:number;tagGroups:{namespace:string;values:string[];labels?:Record<string,string>}[]};
export type CatalogEditions = {publicationRevision:string;groupId:string;selectedProviderWorkId:string|null;items:CatalogWork[];nextCursor:string|null;totalCount:number};
export type CatalogReaderPage = {index:number;url:string;name:string|null;width:number|null;height:number|null;expiresAt:number|null};
export type CatalogReaderManifest = {publicationRevision:string;provider:'kHentai';providerWorkId:string;pages:CatalogReaderPage[];manifestExpiresAt:number|null};

/** The catalog capability this client needs before it can send device filters. */
export const DISPLAY_PREFERENCES_VERSION = 1;

/**
 * Whether a `/status` reply advertises the version this client composes against.
 * An unknown or older capability is treated as unsupported, never as consent.
 */
export function supportsDisplayPreferences(status:unknown):boolean{
  const capabilities=(status as {capabilities?:{displayPreferencesVersion?:unknown}}|null)?.capabilities;
  return typeof capabilities?.displayPreferencesVersion==='number'&&capabilities.displayPreferencesVersion>=DISPLAY_PREFERENCES_VERSION;
}

/** The wire spelling of the exclusions: sorted, deduplicated `(namespace,value)` pairs. */
export function wireExcludedTags(tags:CatalogExcludedTag[]):CatalogExcludedTag[]{
  const seen=new Map<string,CatalogExcludedTag>();
  for(const tag of tags)seen.set(`${tag.namespace}\u0000${tag.value}`,{namespace:tag.namespace,value:tag.value});
  return [...seen.values()].sort((a,b)=>a.namespace===b.namespace?a.value.localeCompare(b.value):a.namespace.localeCompare(b.namespace));
}

export function catalogPath(query:CatalogQuery,cursor:string|null,options:{searchMode:boolean}={searchMode:false}){
  // A cursor already froze the whole query server-side, so the follow-up request
  // carries only the token and cannot accidentally present a different filter.
  if(cursor)return `/v1/mobile-catalog/search?${new URLSearchParams({cursor})}`;
  const params=new URLSearchParams(Object.entries(query).filter(([key])=>key!=='categories'&&key!=='excludedTags').map(([key,value])=>[key,String(value)]));
  const filter=filterParameters(query);
  for(const [key,value] of filter)params.set(key,value);
  if(options.searchMode)params.set('searchMode','mobile');
  return `/v1/mobile-catalog/search?${params}`;
}

/**
 * The encoded category/tag parameters, or a bound violation.
 *
 * The server rejects a filter whose JSON exceeds its own encoded budget, and the
 * native transport rejects an over-long request path. Both bounds are checked
 * here so the caller can report them instead of sending a request that cannot be
 * honored. The text parameter is not part of this budget; the whole path is
 * bounded separately by {@link catalogPathIssue}.
 */
export const FILTER_JSON_MAX_BYTES=2048;
export const CATALOG_PATH_MAX_BYTES=16384;

export type CatalogWireIssue='none'|'filterTooLarge'|'pathTooLong';

function filterParameters(query:Pick<CatalogQuery,'categories'|'excludedTags'>):[string,string][]{
  const pairs:[string,string][]=[];
  if(query.categories!==null)pairs.push(['categories',JSON.stringify(query.categories)]);
  const excluded=wireExcludedTags(query.excludedTags);
  if(excluded.length)pairs.push(['excludedTags',JSON.stringify(excluded)]);
  return pairs;
}

/** UTF-8 byte length, which is what both the server and the native transport count. */
export function utf8Bytes(value:string):number{return new TextEncoder().encode(value).length;}

/** Whether the composed filter JSON is within the server's encoded budget. */
export function catalogFilterBytes(query:Pick<CatalogQuery,'categories'|'excludedTags'>):number{
  return filterParameters(query).reduce((total,[,value])=>total+utf8Bytes(value),0);
}

/**
 * Whether this query can be put on the wire at all.
 *
 * Returns the first violated bound so the caller can explain it. Nothing here
 * throws during render: an over-long input must be reported, not crash the view.
 */
export function catalogPathIssue(query:CatalogQuery,options:{searchMode:boolean}={searchMode:false}):CatalogWireIssue{
  if(catalogFilterBytes(query)>FILTER_JSON_MAX_BYTES)return 'filterTooLarge';
  return utf8Bytes(catalogPath(query,null,options))>CATALOG_PATH_MAX_BYTES?'pathTooLong':'none';
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
