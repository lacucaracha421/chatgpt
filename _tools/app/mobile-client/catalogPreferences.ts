/**
 * Device-local catalog display preferences.
 *
 * These narrow what *this device* is shown. They are read filters only: nothing
 * here writes shared visibility policy, so a mobile exclusion never overwrites
 * the PC's common blocked-tag list and the PC never sees it.
 *
 * Storage rules, matching the catalog refresh and bookmark outbox stores:
 *
 * 1. Scoped to one endpoint, so switching servers cannot apply one server's
 *    filters to another.
 * 2. Corrupt or unusable storage degrades to the default rather than being partly
 *    honored, because a half-read filter would show works the user asked to hide.
 * 3. A stored preference is never discarded by an unknown server; the caller
 *    decides when it may apply. This module only reads and writes.
 */

import {DEFAULT_CATALOG_QUERY,FILTER_JSON_MAX_BYTES,utf8Bytes,wireExcludedTags,type CatalogExcludedTag} from './catalogModel';

export type CatalogPreferences = {categories:number[]|null;excludedTags:CatalogExcludedTag[]};
export const DEFAULT_CATALOG_PREFERENCES:CatalogPreferences={categories:DEFAULT_CATALOG_QUERY.categories,excludedTags:[]};

const NAMESPACE_PATTERN=/^[a-z][a-z0-9_-]*$/;
export const EXCLUDED_TAG_MAX=64;
export const NAMESPACE_MAX=32;
export const TAG_VALUE_MAX_BYTES=200;

/** Whether one pair is a well-formed exclusion the server would accept. */
export function validExcludedTag(tag:unknown):tag is CatalogExcludedTag{
  if(!tag||typeof tag!=='object')return false;
  const {namespace,value}=tag as {namespace?:unknown;value?:unknown};
  if(typeof namespace!=='string'||namespace.length===0||namespace.length>NAMESPACE_MAX||!NAMESPACE_PATTERN.test(namespace))return false;
  // A control character would make the value unrepresentable as a tag.
  if(typeof value!=='string'||value.length===0||/[\u0000-\u001f\u007f]/.test(value)||utf8Bytes(value)>TAG_VALUE_MAX_BYTES)return false;
  return true;
}

/**
 * The encoded size of the filter this preference would send.
 *
 * The server bounds the whole encoded filter, so the per-tag limits alone do not
 * decide whether a set fits.
 */
export function catalogPreferenceBytes(preferences:CatalogPreferences):number{
  const parts:string[]=[];
  if(preferences.categories!==null)parts.push(JSON.stringify(preferences.categories));
  const excluded=wireExcludedTags(preferences.excludedTags);
  if(excluded.length)parts.push(JSON.stringify(excluded));
  return parts.reduce((total,part)=>total+utf8Bytes(part),0);
}

/** Whether this preference set fits inside the server's encoded filter budget. */
export function catalogPreferencesFit(preferences:CatalogPreferences):boolean{
  return catalogPreferenceBytes(preferences)<=FILTER_JSON_MAX_BYTES;
}

/**
 * Parse `namespace:value` from one input, splitting on the first colon only.
 *
 * A single field is what the user asked for, so the tag is entered the way the
 * advanced query already writes it (`female:scat`). The value keeps any later
 * colons, matching the server's exact-text tag identity.
 */
export function parseExcludedTagInput(input:string):CatalogExcludedTag|null{
  const trimmed=input.trim();
  const colon=trimmed.indexOf(':');
  if(colon<=0)return null;
  const tag={namespace:trimmed.slice(0,colon).trim(),value:trimmed.slice(colon+1).trim()};
  return tag.namespace&&tag.value?tag:null;
}

/**
 * Parse the stored JSON for one endpoint into usable preferences.
 *
 * Returns the default when the value is missing, malformed, or holds anything the
 * server would reject. A stored empty category list is meaningful and preserved:
 * it is the user's explicit "no categories" choice.
 */
export function parseCatalogPreferences(raw:string|null):CatalogPreferences{
  if(raw===null)return {...DEFAULT_CATALOG_PREFERENCES};
  let parsed:unknown;
  try{parsed=JSON.parse(raw);}catch{return {...DEFAULT_CATALOG_PREFERENCES};}
  if(!parsed||typeof parsed!=='object'||Array.isArray(parsed))return {...DEFAULT_CATALOG_PREFERENCES};
  const {categories,excludedTags}=parsed as {categories?:unknown;excludedTags?:unknown};
  if(categories!==null&&(!Array.isArray(categories)||categories.some(id=>!Number.isInteger(id)||(id as number)<1||(id as number)>11)))return {...DEFAULT_CATALOG_PREFERENCES};
  if(!Array.isArray(excludedTags)||excludedTags.length>EXCLUDED_TAG_MAX||!excludedTags.every(validExcludedTag))return {...DEFAULT_CATALOG_PREFERENCES};
  const unique=new Map<string,CatalogExcludedTag>();
  for(const tag of excludedTags)unique.set(`${tag.namespace}\u0000${tag.value}`,{namespace:tag.namespace,value:tag.value});
  const preferences:CatalogPreferences={categories:categories===null?null:[...new Set(categories as number[])].sort((a,b)=>a-b),excludedTags:[...unique.values()]};
  // A stored set that no longer fits the encoded budget is unusable as a filter.
  return catalogPreferencesFit(preferences)?preferences:{...DEFAULT_CATALOG_PREFERENCES};
}

const KEY_PREFIX='lakomics.catalog.preferences.';

/** The storage key for one server, so two servers never share a filter set. */
export function catalogPreferencesKey(endpoint:string):string{return `${KEY_PREFIX}${endpoint}`;}

export function readCatalogPreferences(endpoint:string):CatalogPreferences{
  try{return parseCatalogPreferences(localStorage.getItem(catalogPreferencesKey(endpoint)));}
  catch{return {...DEFAULT_CATALOG_PREFERENCES};}
}

export function writeCatalogPreferences(endpoint:string,preferences:CatalogPreferences):void{
  try{localStorage.setItem(catalogPreferencesKey(endpoint),JSON.stringify(preferences));}
  catch{/* Storage may be unavailable; the caller keeps the change in memory. */}
}

/** Forget this device's filters, so the catalog returns to its unfiltered list. */
export function clearCatalogPreferences(endpoint:string):void{
  try{localStorage.removeItem(catalogPreferencesKey(endpoint));}
  catch{/* Nothing to recover when storage is unavailable. */}
}
