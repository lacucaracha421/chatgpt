export type CollectionKind = 'game' | 'manga' | 'movie';
export type CollectionVolume = {id:string; volumeNumber:number; editionIndex:number; displayLabel:string; coverArtworkId?:string|null; localReleaseDate?:string|null};
export type CollectionSummary = {
  id:string; name:string; type:CollectionKind; description?:string|null; overview?:string|null;
  coverAssetId?:string|null; selectedWorkArtworkId?:string|null; selectedHeroArtworkId?:string|null; selectedBackdropArtworkId?:string|null;
  author?:string|null; developer?:string|null; director?:string|null; publisher?:string|null; year?:number|null; runtimeMinutes?:number|null;
  showcase:boolean; showcaseOrder?:number|null; volumes?:CollectionVolume[];
};
export type CollectionDetail = CollectionSummary & {volumes:CollectionVolume[]; artworks:{id:string;kind:string;selected:boolean;thumbnailAvailable:boolean;originalAvailable:boolean}[]};
export type CollectionPage = {ready:boolean;revision:string|null;publishedAt:string|null;items:CollectionSummary[];nextCursor:string|null};
export function collectionPath(type:CollectionKind, q:string, showcase:boolean, cursor:string|null) {
  const params = new URLSearchParams({type,q,showcase:String(showcase),limit:showcase?'16':'48'});
  if (cursor) params.set('cursor',cursor);
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
