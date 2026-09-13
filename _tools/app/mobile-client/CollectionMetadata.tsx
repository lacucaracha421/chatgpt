import type {CollectionDetail} from './collectionModel';
export function CollectionMetadata({item}:{item:CollectionDetail}) {
  const rows:[string,string|number|null|undefined][]=[
    ['내 평점',item.myScore==null?null:`★ ${item.myScore.toFixed(1)} / 5`],
    ['작가',item.author],['개발사',item.developer],
    [item.type==='game'?'배급사':'출판사',item.publisher],['감독',item.director],['제작사',item.productionCompany],
    [item.type==='manga'?'출간년도':item.type==='game'?'발매일':'개봉·방영',item.type==='manga'?item.year:item.seasonDateRange?.join(' – ')||item.releaseDate||item.year],
    ['플랫폼',item.platforms],['상영시간',item.runtimeMinutes?`${item.runtimeMinutes}분`:null],
    ['TMDB 평점',item.type==='movie'?item.externalScore:null],['장르',item.genres],['상태',item.series?.status],
  ];
  return <dl className="collection-metadata" aria-label="작품 정보">{rows.filter(([,value])=>value!==null&&value!==undefined&&value!=='').map(([label,value])=><div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl>;
}
