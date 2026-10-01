export type CollectionKind = 'game' | 'manga' | 'movie' | 'av';
export type CollectionFilters = {sort:'recent'|'media_date'|'name';direction:'asc'|'desc';rating:'all'|'unrated'|number};
export const defaultCollectionFilters = ():CollectionFilters => ({sort:'media_date',direction:'desc',rating:'all'});
export type CollectionVolume = {id:string; volumeNumber:number; editionIndex:number; displayLabel:string; coverArtworkId?:string|null; localReleaseDate?:string|null;
  /** From an upgraded PC (`coverFocus`): where the spine strip sits across the current cover, 0–1. */
  coverFocusX?:number|null};
export type AvPortraitCrop = {artworkId:string;x:number;y:number;w:number;h:number};
/** A performer's StashDB / Commons portrait as published (`portraitImage` feature); the bytes come through the Home cover ticket. */
export type AvPortraitImage = {sha256:string;sizeBytes:number;contentType:string;width:number;height:number};
export type AvPerson = {id:string;name:string;nameJa?:string|null;role:'performer'|'director';order:number;portraitCrop?:AvPortraitCrop|null;portraitImage?:AvPortraitImage|null};
export type AvInfo = {productCode?:string|null;titleJa?:string|null;maker?:string|null;label?:string|null;series?:string|null;genres:string[];releaseDate?:string|null;people:AvPerson[]};
export type CollectionSummary = {
  artworkVersions?:Record<string,{thumbnail?:string|null;original?:string|null}>;
  id:string; name:string; type:CollectionKind; description?:string|null; overview?:string|null;
  av?:AvInfo|null;
  /** 원제: for manga, usually the Japanese title the PC filled from MangaDex. */
  originalTitle?:string|null;
  coverAssetId?:string|null; selectedWorkArtworkId?:string|null; selectedHeroArtworkId?:string|null; selectedBackdropArtworkId?:string|null;
  author?:string|null; developer?:string|null; director?:string|null; publisher?:string|null; year?:number|null; runtimeMinutes?:number|null;
  platforms?:string|null; genres?:string|null; productionCompany?:string|null; externalScore?:number|null; seasonDateRange?:string[]|null;
  myScore?:number|null; releaseDate?:string|null; createdAt?:string;
  /** From an upgraded PC (`workRecord`): the 내 기록 상태 id (game done|playing|unplayed, av watched|unwatched, manga collecting|complete, movie watched|watching|unwatched). */
  status?:string|null;
  /** From an upgraded PC (`workRecord`), games only: the 기기 I own it on. */
  ownedPlatform?:string|null;
  /** From an upgraded server: the work's selected (else first) spine artwork, ticketed like the cover. */
  spineArtworkId?:string|null;
  showcase:boolean; showcaseOrder?:number|null; volumes?:CollectionVolume[];
  /** Manga only, from an upgraded PC: 신간 알림 state (`available` = an Aladin/Kakao binding). */
  releaseWatch?:{enabled:boolean;available:boolean}|null;
  /** Manga only, from an upgraded PC: owned volumes per tracked edition. */
  ownedVolumes?:{editionIndex:number;count:number}[]|null;
  /** Manga only, from an upgraded PC: per-volume release data behind 신간 알림 (absent before). */
  releaseSchedule?:ReleaseSchedule|null;
};
/** A Kakao (Korean edition) volume: `date` is `YYYY-MM-DD`; `upcoming` = pre-registered. */
export type KakaoReleaseVolume = {volumeNumber:number;date:string|null;status:'upcoming'|'released'|null};
export type ReleaseSchedule = {
  kakao:null|{editionIndex:number;checkedAt:string|null;volumes:KakaoReleaseVolume[]};
  mangadex:null|{checkedAt:string|null;latestVolume:number|null;volumes:{volumeNumber:number;editionIndex:number|null}[]};
};
export type CollectionSeason = {id:number;seasonNumber:number;name:string;airDate:string|null;posterArtworkId:string|null;episodes:{id:number;episodeNumber:number;name:string;airDate:string|null;runtimeMinutes:number|null}[]};
/** TMDB film details as published by the PC: text only, without posters or local collection links. */
export type CollectionFilm = {
  cast:{name:string;character:string}[];
  releases:{country:string;releaseType:number;date:string;certification:string}[];
  related:{collectionName:string;parts:{movieId:number;title:string;releaseDate:string|null}[]}|null;
};
export type CollectionDetail = CollectionSummary & {film?:CollectionFilm|null;series?:{status:string|null;cast:string[];seasons:CollectionSeason[]}|null;volumes:CollectionVolume[]; artworks:{id:string;kind:string;selected:boolean;thumbnailAvailable:boolean;originalAvailable:boolean}[]};
/** A published AV person (`GET /v1/collections/people/{id}`); text only, never images. */
export type CollectionPersonProfile = {
  source:string; name:string|null; aliases:string[];
  birthDate:string|null; heightCm:number|null;
  bandIn:number|null; waistIn:number|null; hipIn:number|null; cup:string|null; breastType:string|null;
  careerStart:number|null; careerEnd:number|null;
  urls:{site:string;url:string}[];
};
export type CollectionPerson = {
  id:string; memo:string|null; favorite:boolean;
  profile:CollectionPersonProfile|null;
  portrait:null|{source:'stashdb'|'commons'|'cover';author:string|null;license:string|null;licenseUrl:string|null;sourceUrl:string|null};
};
export const personPath=(personId:string)=>`/v1/collections/people/${encodeURIComponent(personId)}`;
/** The person in a `GET /v1/collections/people/{id}` reply, or null when it is not that person's. */
export function personReply(reply:unknown,personId:string):CollectionPerson|null {
  const person=(reply as {person?:unknown}|null)?.person as CollectionPerson|null|undefined;
  return person&&typeof person==='object'&&person.id===personId?person:null;
}
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
/**
 * The published cover focus as the shared bookcase reads it. The publication carries only the
 * position (never for method `none`) and only for the current cover; `method` is not published
 * and the bookcase does not read it.
 */
export function coverFocuses(volumes:CollectionVolume[]):CollectionCoverFocus[] {
  return volumes.flatMap(volume=>volume.coverArtworkId&&typeof volume.coverFocusX==='number'&&volume.coverFocusX>=0&&volume.coverFocusX<=1
    ?[{volumeId:volume.id,coverArtworkId:volume.coverArtworkId,focusX:volume.coverFocusX,method:'head' as const}]:[]);
}
export function editions(volumes:CollectionVolume[]) { return [...new Set(volumes.map(v=>v.editionIndex))].sort((a,b)=>a-b); }
export function collectionCover(item:CollectionSummary) { return item.selectedWorkArtworkId ?? [...(item.volumes ?? [])].sort((a,b)=>a.editionIndex-b.editionIndex || a.volumeNumber-b.volumeNumber).find(v=>v.coverArtworkId)?.coverArtworkId; }

export {volumeLabel} from '../src/collections/collectionFormat';

/** The 원제 worth showing beside the title: present and not just the title again. */
export function originalTitle(item:CollectionSummary){const value=item.originalTitle?.trim()??'';return value&&value!==item.name.trim()?value:'';}
export const collectionCardCredit=(item:CollectionSummary)=>collectionCredit(item);
export {collectionCardDate};

export const SORT_LABELS:Record<CollectionFilters['sort'],string>={media_date:'최신순',recent:'최근 추가',name:'제목'};
/** Direction words follow the sort: dates read newest/oldest, titles read alphabetical/reverse. */
export function sortDirectionLabels(sort:CollectionFilters['sort']):Record<CollectionFilters['direction'],string> {
  return sort==='name'?{asc:'가나다순',desc:'역순'}:{desc:'최신순',asc:'오래된순'};
}
export const ratingLabel=(rating:CollectionFilters['rating'])=>typeof rating==='number'?`★ ${rating.toFixed(1)}`:rating==='unrated'?'미평가':'전체';
/** A volume's local release date as `2024.3.5`, or '' when the publication has none. */
export function volumeReleaseLabel(volume:CollectionVolume) {
  const match=/^(\d{4})-(\d{2})(?:-(\d{2}))?/.exec(volume.localReleaseDate?.trim()??'');
  if(!match)return volume.localReleaseDate?.trim()??'';
  return [match[1],Number(match[2]),match[3]?Number(match[3]):null].filter(part=>part!==null).join('.');
}
import {collectionCardDate,collectionCredit} from '../src/collections/collectionFormat';
import type {CollectionCoverFocus} from '../src/library/types';
