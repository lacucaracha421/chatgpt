import {useId, useState} from 'react';
import {Button} from './ui';
import type {CollectionFilm} from './collectionModel';

const countryNames:Record<string,string> = {KR:'한국',US:'미국',JP:'일본',GB:'영국',FR:'프랑스',DE:'독일',CA:'캐나다',AU:'호주',CN:'중국',HK:'홍콩',TW:'대만'};
const releaseTypes:Record<number,string> = {1:'프리미어',2:'제한 개봉',3:'극장 개봉',4:'디지털',5:'실물 매체',6:'TV'};

/**
 * Cast, release history and the film's TMDB collection, mirroring the PC detail.
 * The publication carries no TMDB ids for local works, so related films are not linked.
 */
export function FilmDetails({film}:{film:CollectionFilm}) {
  const [allReleases,setAllReleases]=useState(false);
  const releaseListId=useId();
  const releases=[...film.releases].sort((a,b)=>a.date.localeCompare(b.date));
  // By default only Korean releases and the earliest one worldwide are shown.
  const visibleReleases=allReleases?releases:releases.filter((row,index)=>row.country==='KR'||index===0);
  const parts=[...(film.related?.parts??[])].sort((a,b)=>(a.releaseDate??'9999').localeCompare(b.releaseDate??'9999'));
  return <>
    {film.cast.length>0&&<section className="collection-block collection-film-cast" aria-label="출연"><h2>출연</h2>
      <ul>{film.cast.slice(0,8).map((person,index)=><li key={index}><strong>{person.name}</strong>{person.character&&<small>{person.character}</small>}</li>)}</ul></section>}
    {releases.length>0&&<section className="collection-block collection-film-releases" aria-label="개봉 정보">
      <div className="collection-film-heading"><h2>개봉 정보</h2>
        {releases.some((row,index)=>row.country!=='KR'&&index!==0)&&<Button variant="ghost" className="collection-film-toggle" aria-expanded={allReleases} aria-controls={releaseListId} onClick={()=>setAllReleases(open=>!open)}>{allReleases?'접기':'전체 보기'}</Button>}</div>
      <ul id={releaseListId}>{visibleReleases.map((release,index)=><li key={index}>
        <time className="numeric" dateTime={release.date}>{release.date.replace(/-/g,'.')}</time>
        <span>{[countryNames[release.country]??release.country,releaseTypes[release.releaseType],release.certification].filter(Boolean).join(' · ')}</span>
      </li>)}</ul></section>}
    {parts.length>0&&<section className="collection-block collection-film-related" aria-label="관련 작품"><h2>관련 작품</h2>
      {film.related?.collectionName&&<p className="collection-film-subtitle">{film.related.collectionName}</p>}
      <ul>{parts.map(part=><li key={part.movieId}><strong>{part.title}</strong>{part.releaseDate&&<small className="numeric">{part.releaseDate.slice(0,4)}</small>}</li>)}</ul></section>}
  </>;
}
