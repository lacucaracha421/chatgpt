import {useRef,useState} from 'react';
import type {FavoriteEntry} from '../../src/library/types';
import {BottomSheet} from '../BottomSheet';
import {Button} from '../ui';
import {BusyLabel} from '../../src/shared/ui/BusyLabel';
import {CharacterImage,useCharacterAssets} from './CharacterAssets';
import {representativeAsset} from './model';
import type {CharacterNode} from '../characterModel';

export function CoverSheet({entry,node,revision,busy,error,onSave,onClose}:{entry:FavoriteEntry;node:CharacterNode;revision:string;busy:boolean;error:string;onSave(id:string,y:number):Promise<boolean>;onClose():void}) {
  const assets=useCharacterAssets(node.id,revision,true);
  const [selected,setSelected]=useState(representativeAsset(entry,node)),[y,setY]=useState(entry.coverY);
  const drag=useRef<{pointer:number;y:number;coverY:number}|null>(null);
  return <BottomSheet title="대표 이미지 바꾸기" tall stacked onClose={onClose}>
    <div className="favorite-cover-editor">
      <div className="favorite-cover-preview" onPointerDown={event=>{
        if(event.button>0)return;
        event.currentTarget.setPointerCapture(event.pointerId);drag.current={pointer:event.pointerId,y:event.clientY,coverY:y};
      }} onPointerMove={event=>{
        const from=drag.current;if(!from||from.pointer!==event.pointerId)return;
        setY(Math.max(0,Math.min(100,from.coverY-(event.clientY-from.y)/event.currentTarget.clientHeight*100)));
      }} onPointerUp={()=>{drag.current=null;}} onPointerCancel={()=>{drag.current=null;}}>
        <CharacterImage id={selected} y={y} rating={assets.page?.items.find(asset=>asset.id===selected)?.contentRating}/>
      </div>
      <label className="favorite-cover-position">세로 위치<input aria-label="대표 이미지 세로 위치" type="range" min="0" max="100" value={y} onChange={event=>setY(Number(event.target.value))}/></label>
      <BusyLabel busy={assets.busy}><span className="hint">불러오는 중…</span></BusyLabel>
      {assets.error&&<p role="alert">{assets.error}<Button variant="ghost" onClick={assets.reload}>다시 시도</Button></p>}
      <div className="favorite-cover-assets">{assets.page?.items.map(asset=><button key={asset.id} aria-label="대표 이미지 선택" aria-pressed={selected===asset.id} onClick={()=>{setSelected(asset.id);setY(50);}}><CharacterImage id={asset.id} rating={asset.contentRating}/></button>)}</div>
      {assets.page?.has_more&&<Button variant="ghost" disabled={assets.busy} onClick={assets.more}>더 보기</Button>}
      {assets.page&&!assets.page.items.length&&<p className="hint">이미지 없음</p>}
      {error&&<p role="alert">{error}</p>}
      <Button className="favorite-apply" disabled={!selected||busy} onClick={()=>{if(selected)void onSave(selected,y).then(saved=>{if(saved)onClose();});}}>바꾸기</Button>
    </div>
  </BottomSheet>;
}
