export type CollectionKind = 'game' | 'manga' | 'movie';
export type CollectionFilters = {sort:'recent'|'media_date'|'name';direction:'asc'|'desc';rating:'all'|'unrated'|number};
export const defaultCollectionFilters = ():CollectionFilters => ({sort:'media_date',direction:'desc',rating:'all'});
export type CollectionVolume = {id:string; volumeNumber:number; editionIndex:number; displayLabel:string; coverArtworkId?:string|null; localReleaseDate?:string|null};
export type CollectionSummary = {
  artworkVersions?:Record<string,{thumbnail?:string|null;original?:string|null}>;
  id:string; name:string; type:CollectionKind; description?:string|null; overview?:string|null;
  coverAssetId?:string|null; selectedWorkArtworkId?:string|null; selectedHeroArtworkId?:string|null; selectedBackdropArtworkId?:string|null;
  author?:string|null; developer?:string|null; director?:string|null; publisher?:string|null; year?:number|null; runtimeMinutes?:number|null;
  platforms?:string|null; genres?:string|null; productionCompany?:string|null; externalScore?:number|null; seasonDateRange?:string[]|null;
  myScore?:number|null; releaseDate?:string|null; createdAt?:string;
  showcase:boolean; showcaseOrder?:number|null; volumes?:CollectionVolume[];
};
export type CollectionSeason = {id:number;seasonNumber:number;name:string;airDate:string|null;posterArtworkId:string|null;episodes:{id:number;episodeNumber:number;name:string;airDate:string|null;runtimeMinutes:number|null}[]};
export type CollectionDetail = CollectionSummary & {series?:{status:string|null;cast:string[];seasons:CollectionSeason[]}|null;volumes:CollectionVolume[]; artworks:{id:string;kind:string;selected:boolean;thumbnailAvailable:boolean;originalAvailable:boolean}[]};
export type CollectionPage = {totalCount?:number;ready:boolean;revision:string|null;publishedAt:string|null;items:CollectionSummary[];nextCursor:string|null;filterVersion?:1};
export function collectionPath(type:CollectionKind, q:string, showcase:boolean, cursor:string|null, filters?:CollectionFilters) {
  const params = new URLSearchParams({type,q,showcase:String(showcase),limit:showcase?'16':'48'});
  if (cursor) params.set('cursor',cursor);
  if(filters&&!showcase){params.set('sort',filters.sort);params.set('direction',filters.direction);params.set('rating',String(filters.rating));}
  return `/v1/collections?${params}`;
}
export function editionVolumes(volumes:CollectionVolume[], edition:number) {
  return volumes.filter(volume=>volume.editionIndex===edition).sort((a,b)=>a.volumeNumber-b.volumeNumber || a.id.localeCompare(b.id));
}
export function editions(volumes:CollectionVolume[]) { return [...new Set(volumes.map(v=>v.editionIndex))].sort((a,b)=>a-b); }
export function collectionCover(item:CollectionSummary) { return item.selectedWorkArtworkId ?? [...(item.volumes ?? [])].sort((a,b)=>a.editionIndex-b.editionIndex || a.volumeNumber-b.volumeNumber).find(v=>v.coverArtworkId)?.coverArtworkId; }

export function volumeLabel(volume:CollectionVolume) {
  const label=volume.displayLabel?.trim();
  return !label ? `${volume.volumeNumber}권` : /^\d+(?:\.\d+)?$/.test(label) ? `${label}권` : label;
}

export function collectionCardCredit(item:CollectionSummary){return (item.type==='movie'?item.productionCompany:item.type==='game'?item.developer:item.author)?.trim()??'';}
export function collectionCardDate(item:CollectionSummary){
  const short=(date:string)=>{const [y,m,d]=date.split('-');return `${y.slice(-2)}.${Number(m)}.${Number(d)}`;};
  if(item.type==='movie'&&item.seasonDateRange?.length===2){const [first,last]=item.seasonDateRange;return first===last?short(first):`${short(first)}~${short(last)}`;}
  return item.year?String(item.year):item.releaseDate?.slice(0,4)??'';
}
