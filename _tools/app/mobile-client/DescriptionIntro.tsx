import './assetSearch.css';
import {PhotoIcon} from '@heroicons/react/24/outline';
import {Button,EmptyState} from './ui';
import type {DescriptionMeta} from './descriptionSearch';

/**
 * The 내용 검색 result state's lead-in: the order note over a found list, or the one quiet sentence when
 * there is no list. "아직 준비 중" is not an error: the captions simply are not published yet.
 */
export function DescriptionIntro({meta,force,count,busy,onForce}:{meta?:DescriptionMeta;force:boolean;count:number;busy:boolean;onForce():void}) {
  if(!meta)return null;
  if(count>0)return <p className="description-note" role="status">관련도순 · 상위 {count.toLocaleString('ko-KR')}장</p>;
  if(busy)return null;
  if(!meta.ready)return <EmptyState icon={PhotoIcon} title="아직 준비 중" hint="이미지 설명을 만드는 중입니다. 준비되면 여기서 내용으로 찾을 수 있어요."/>;
  return <EmptyState icon={PhotoIcon} title="검색 결과 없음">{meta.gated&&!force&&<Button type="button" onClick={onForce}>그래도 가장 비슷한 그림 보기</Button>}</EmptyState>;
}
