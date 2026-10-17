import type {MangaFrequentIndex,MangaIndexIdentity} from '../src/library/types';
import {mangaIndexKey} from '../src/manga/mangaIndexModel';
import {PinSolidIcon} from '../src/shared/ui/PinIcon';
import type {useMangaIndex} from './useMangaIndex';
import {SectionLabel} from './ui';
import {useLongPress} from '../src/shared/useLongPress';

function IndexChip({row,count,pinned,pending,active,onPick,onPin}:{row:MangaIndexIdentity;count:number;pinned:boolean;pending:boolean;active:boolean;onPick():void;onPin():void}){
  const press=useLongPress({onLongPress:onPin});
  return <button type="button" className={`catalog-index-chip${active?' is-active':''}`} aria-label={`${row.label} ${count}`} aria-pressed={active}
    {...press.bind} onClick={press.click(onPick)}>
    {pinned&&<PinSolidIcon/>}<span>{row.label}</span><small className="numeric">{count}</small>{pending&&<span className="catalog-index-pending" aria-label="고정 저장 대기">·</span>}
  </button>;
}
export function CatalogIndex({index,filter,onFilter}:{index:ReturnType<typeof useMangaIndex>;filter:MangaIndexIdentity|null;onFilter(row:MangaIndexIdentity|null):void}){
  if(!index.available||!index.frequent)return null;
  const keys=new Set(index.pins.map(mangaIndexKey)),counts=[...index.frequent.tags,...index.frequent.artists];
  const chip=(row:MangaIndexIdentity,count:number,pinned=false,pending=false)=><IndexChip key={mangaIndexKey(row)} row={row} count={count} pinned={pinned} pending={pending} active={!!filter&&mangaIndexKey(filter)===mangaIndexKey(row)} onPick={()=>onFilter(filter&&mangaIndexKey(filter)===mangaIndexKey(row)?null:row)} onPin={()=>index.togglePin(row)}/>;
  function section(title:string,entries:MangaFrequentIndex['tags'],limit:number){return <section className="catalog-index-section" aria-label={title}><SectionLabel title={title}/><div className="catalog-index-chips">{entries.filter(row=>!keys.has(mangaIndexKey(row))).slice(0,limit).map(row=>chip(row,row.count))}</div></section>;}
  return <div className="catalog-index" aria-label="망가 목차">
    {index.pins.length>0&&<section className="catalog-index-section" aria-label="고정"><SectionLabel title="고정"/><div className="catalog-index-chips">{index.pins.map(pin=>chip(pin,counts.find(row=>mangaIndexKey(row)===mangaIndexKey(pin))?.count??0,true,pin.pending))}</div></section>}
    {index.frequent.bookmarkCount===0?<p className="hint">북마크한 작품이 생기면 자주 찾는 태그와 작가가 여기에 모입니다.</p>:<>{section('자주 찾는 태그',index.frequent.tags,8)}{section('작가',index.frequent.artists,5)}</>}
    {index.frequent.bookmarkCount>0&&<p className="hint">태그를 누르면 거르고, 길게 누르면 고정하거나 해제합니다. 고정은 PC와 함께 씁니다.</p>}
    {(index.message||index.pending>0)&&<p role={index.message?'alert':'status'} className="catalog-bookmark-state">{index.message||'고정 저장 대기'}</p>}
  </div>;
}
