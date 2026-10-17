import type {ComponentType,CSSProperties,ReactNode,SVGProps} from 'react';
import {ArrowPathIcon,ArrowsPointingInIcon,ArrowsRightLeftIcon,ArrowsUpDownIcon,ClipboardDocumentIcon,EyeIcon,EyeSlashIcon,FolderPlusIcon,InboxStackIcon,InformationCircleIcon,MinusCircleIcon,PencilSquareIcon,PhotoIcon,RectangleStackIcon,SparklesIcon,Square2StackIcon,SwatchIcon,TrashIcon} from '@heroicons/react/24/outline';
import {PinIcon} from '../src/shared/ui/PinIcon';
import type {ActionIcon,BoundSheetItem} from '../src/shared/contextActions';
import {BottomSheet} from './BottomSheet';
import {useAndroidBack} from './cards/useAndroidBack';
import './moreSheet.css';

/** The tablet's icon for each shared action key (Heroicons outline; the pin is the shared glyph). */
export const ACTION_ICONS:Record<ActionIcon,ComponentType<SVGProps<SVGSVGElement>>>={
  pin:PinIcon,pencil:PencilSquareIcon,plus:FolderPlusIcon,palette:SwatchIcon,move:ArrowsRightLeftIcon,trash:TrashIcon,sparkles:SparklesIcon,
  hide:EyeSlashIcon,show:EyeIcon,merge:ArrowsPointingInIcon,container:InboxStackIcon,copy:ClipboardDocumentIcon,album:RectangleStackIcon,
  info:InformationCircleIcon,remove:MinusCircleIcon,cover:PhotoIcon,compare:Square2StackIcon,refresh:ArrowPathIcon,order:ArrowsUpDownIcon,
};

/** The first row of an action sheet: what the actions apply to. */
export type ActionSheetTarget={
  /** The 48 px thumbnail content: covers (`stack` for a selection), or a glyph. */
  thumb:ReactNode;
  stack?:boolean;
  /** A glyph thumb takes the folder's colour. */
  color?:string;
  name:string;
  /** One line: kind · count · path. */
  meta?:string;
};
export type ActionSheetItem=BoundSheetItem&{
  /** Why the item cannot run, or what it does, as a second line. */
  hint?:string;
  /** The sheet stays open after the item ran, to show its outcome. */
  keepOpen?:boolean;
};

/**
 * The long-press sheet (TABLET-STRUCT-001): the existing bottom sheet with MoreSheet's rows. The
 * target names itself in the title row, the items follow in the shared action order with the
 * destructive ones last under a hairline. Choosing an item closes the sheet and runs it.
 */
export function ActionSheet({target,items,onClose,onChoose,notice,status}:{target:ActionSheetTarget;items:ActionSheetItem[];onClose():void;/** Called instead of `onClose` when an item is chosen, for a sheet that stays open to show a failure. */onChoose?():void;notice?:string;/** A finished outcome (for example 출처를 복사했습니다.) under the items. */status?:string}) {
  // Android Back closes the sheet first, wherever it was opened from.
  useAndroidBack(onClose);
  const row=(item:ActionSheetItem)=>{
    const Icon=ACTION_ICONS[item.icon];
    return <button key={item.id} type="button" className={`workspace-index-link${item.danger?' is-danger':''}`} disabled={item.disabled} aria-description={item.hint}
      onClick={()=>{if(!item.keepOpen)(onChoose??onClose)();item.run();}}>
      <span className="more-panel__icon" aria-hidden="true"><Icon/></span><span className="more-panel__label">{item.label}{item.hint&&<small>{item.hint}</small>}</span>
    </button>;
  };
  const regular=items.filter(item=>!item.danger),destructive=items.filter(item=>item.danger);
  const heading=<>
    <span className={`action-sheet__thumb${target.stack?' action-sheet__thumb--stack':''}${target.color!==undefined?' action-sheet__thumb--icon':''}`} style={target.color!==undefined?{'--folder-color':target.color} as CSSProperties:undefined} aria-hidden="true">{target.thumb}</span>
    <span className="action-sheet__text"><span className="action-sheet__name">{target.name}</span>{target.meta&&<span className="action-sheet__meta">{target.meta}</span>}</span>
  </>;
  return <BottomSheet title={target.name} heading={heading} onClose={onClose}><div className="tablet-more">
    {regular.length>0&&<nav className="more-panel__navigation" aria-label={target.name}>{regular.map(row)}</nav>}
    {destructive.length>0&&<nav className="more-panel__navigation more-panel__navigation--danger" aria-label={`${target.name} 삭제`}>{destructive.map(row)}</nav>}
    {notice&&<p role="alert" className="error-message">{notice}</p>}
    {status&&<p role="status" className="hint">{status}</p>}
  </div></BottomSheet>;
}
