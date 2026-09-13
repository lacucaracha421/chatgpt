import {Button} from './ui';
import type {CollectionFilters as Filters} from './collectionModel';

export function CollectionFilters({value,onChange}:{value:Filters;onChange(value:Filters):void}) {
  const rating=typeof value.rating==='number'?`${value.rating.toFixed(1)}점`:value.rating==='all'?'전체':'미평가';
  const chooseRating=(rating:Filters['rating'])=>onChange({...value,rating});
  return <div className="collection-controls" aria-label="컬렉션 필터">
    <div className="collection-sort">
      <select aria-label="컬렉션 정렬" value={value.sort} onChange={event=>onChange({...value,sort:event.target.value as Filters['sort']})}>
        <option value="media_date">출시·출간·개봉일</option><option value="recent">최근 추가</option><option value="name">제목</option>
      </select>
      <Button variant="ghost" aria-label="정렬 방향" onClick={()=>onChange({...value,direction:value.direction==='desc'?'asc':'desc'})}>{value.direction==='desc'?'내림차순':'오름차순'}</Button>
    </div>
    <select className="collection-rating-compact" aria-label="별점 필터" value={value.rating} onChange={event=>chooseRating(event.target.value==='all'||event.target.value==='unrated'?event.target.value:Number(event.target.value))}><option value="all">별점 전체</option><option value="unrated">미평가</option>{Array.from({length:11},(_,i)=>i/2).map(score=><option key={score} value={score}>★ {score.toFixed(1)}</option>)}</select>
    <div className="collection-rating">
      <span>내 별점 · {rating}</span>
      <input type="range" aria-label="내 별점" aria-valuetext={rating} min={0} max={5} step={0.5} value={typeof value.rating==='number'?value.rating:0}
        onChange={event=>chooseRating(Number(event.target.value))} onPointerUp={event=>chooseRating(Number(event.currentTarget.value))}
        onKeyUp={event=>{if(['Home','End','ArrowLeft','ArrowRight','ArrowUp','ArrowDown'].includes(event.key))chooseRating(Number(event.currentTarget.value));}}/>
      <div role="group" aria-label="별점 필터 범위"><Button variant="ghost" aria-pressed={value.rating==='all'} onClick={()=>chooseRating('all')}>전체</Button><Button variant="ghost" aria-pressed={value.rating==='unrated'} onClick={()=>chooseRating('unrated')}>미평가</Button></div>
    </div>
  </div>;
}
