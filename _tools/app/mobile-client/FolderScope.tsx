import {useState} from 'react';
import {InformationCircleIcon} from '@heroicons/react/24/outline';
import {IconButton,SegmentedControl} from './ui';
import {BottomSheet} from './BottomSheet';

/**
 * The PC's 미분류 / 전체 switch for a folder that has subfolders: 미분류 lists what is filed in
 * this folder itself, 전체 lists it together with everything below it. Each segment carries its
 * own count, so neither number stands in for the other.
 */
export function FolderScope({direct,total,subtree,onChange}:{direct?:number;total?:number;subtree:boolean;onChange(subtree:boolean):void}) {
  const [help,setHelp]=useState(false);
  return <section className="folder-intro folder-scope">
    <div className="folder-filter">
      <SegmentedControl<'direct'|'all'> label="이미지 범위" options={[{value:'direct',label:'미분류',count:direct},{value:'all',label:'전체',count:total}]} value={subtree?'all':'direct'} onChange={value=>onChange(value==='all')}/>
      <IconButton label="미분류와 전체 설명" icon={InformationCircleIcon} onClick={()=>setHelp(true)}/>
    </div>
    {help&&<BottomSheet title="미분류와 전체" onClose={()=>setHelp(false)}><div className="folder-filter__explanation"><p><strong>미분류</strong>: 이 폴더에 바로 들어 있고 아직 하위 폴더에 없는 이미지</p><p><strong>전체</strong>: 하위 폴더까지 모두</p></div></BottomSheet>}
  </section>;
}
