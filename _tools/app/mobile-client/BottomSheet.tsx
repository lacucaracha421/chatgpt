import type {ReactNode} from 'react';
import {Button,Dialog,DialogDescription} from './ui';
export function BottomSheet({title,onClose,children}:{title:string;onClose():void;children:ReactNode}) {
  return <Dialog open title={title} onClose={onClose}><DialogDescription className="sr-only">옵션을 선택하면 적용됩니다.</DialogDescription><div className="library-sheet">{children}<Button variant="ghost" onClick={onClose}>닫기</Button></div></Dialog>;
}
