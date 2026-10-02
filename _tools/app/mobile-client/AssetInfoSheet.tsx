import {useRef} from 'react';
import {XMarkIcon} from '@heroicons/react/24/outline';
import {Dialog, DialogDescription, IconButton} from './ui';
import type {Asset} from './types';
import {ViewerInfo} from './ViewerInfo';
import './Viewer.css';
import './AssetInfoSheet.css';

/** Gallery overlay: portrait bottom sheet, landscape side sheet; the gallery keeps its position. */
export function AssetInfoSheet({asset,onClose}:{asset:Asset;onClose():void}) {
  const start = useRef<{x:number;y:number}|null>(null);
  return <Dialog open title="미디어 정보" onClose={onClose}>
    <DialogDescription className="sr-only">선택한 에셋의 출처와 파일 정보</DialogDescription>
    <div className="asset-info-sheet">
      <header className="asset-info-sheet__header" onPointerDown={event=>{
        start.current={x:event.clientX,y:event.clientY};
        event.currentTarget.setPointerCapture?.(event.pointerId);
      }} onPointerUp={event=>{
        const from=start.current;start.current=null;
        if(from&&event.clientY-from.y>80&&Math.abs(event.clientX-from.x)<40)onClose();
      }} onPointerCancel={()=>{start.current=null;}}>
        <strong>정보</strong><IconButton label="정보 닫기" icon={XMarkIcon} onClick={onClose}/>
      </header>
      <ViewerInfo asset={asset}/>
    </div>
  </Dialog>;
}
