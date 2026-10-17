import {useState} from 'react';
import {bindSheetItems,imageActionDefs,uniqueSources} from '../src/shared/contextActions';
import {ActionSheet} from './ActionSheet';
import {Cover} from './CoverGroup';
import {errorText} from './transport';
import type {Asset} from './types';

/**
 * The selection bar's ⋯ sheet: the shared image list for the selected assets. Each item appears only
 * when the tablet can run it here (정보 열기 for one image, 이 앨범에서 빼기 inside an album, 휴지통으로
 * where the trash is available). The PC's video comparison stays on the PC.
 */
export function ImageActionSheet({assets,count,scopeName,busy,albumCount,inAlbum,onAlbum,onRemoveFromAlbum,onInfo,onTrash,onClose}:{
  /** The selected images that are loaded, for their thumbnails and source addresses. */assets:Asset[];
  count:number;scopeName:string;busy:boolean;albumCount:number;inAlbum:boolean;
  onAlbum():void;onRemoveFromAlbum():void;onInfo?():void;onTrash?():void;onClose():void;
}) {
  const [status,setStatus]=useState(''),[error,setError]=useState('');
  const sources=uniqueSources(assets.map(asset=>asset.source_url));
  const items=bindSheetItems(imageActionDefs({count,busy,sourceCount:assets.length===count?sources.length:0,albumCount,inAlbum}),{
    'copy-source':()=>{
      setStatus('');setError('');
      void navigator.clipboard.writeText(sources.join('\n')).then(()=>setStatus(sources.length===1?'출처를 복사했습니다.':`출처 ${sources.length}개를 복사했습니다.`),reason=>setError(errorText(reason)));
    },
    album:onAlbum,
    'remove-album':onRemoveFromAlbum,
    info:onInfo,
    trash:onTrash,
  }).map(item=>item.id==='copy-source'?{...item,keepOpen:true}:item);
  const covers=assets.slice(0,2);
  return <ActionSheet onClose={onClose} items={items} status={status} notice={error}
    target={{name:`${count.toLocaleString('ko-KR')}개 선택`,meta:scopeName||undefined,stack:covers.length>1,thumb:<>{covers.map(asset=><Cover key={asset.id} asset={asset} paused={false}/>)}</>}}/>;
}
