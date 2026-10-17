import {Button} from './ui';
import {CLASSIFICATION_COLORS,CLASSIFICATION_ICONS,ClassificationIcon,classificationColor} from '../src/classification/classificationAppearance';
import type {ClassificationKind} from '../src/library/types';
import './albumManagement.css';

/**
 * The icon and colour choices of 아이콘 및 색상, shared by albums and folders: a preview of the name in
 * its look, the icon and colour pickers, and a reset to the defaults. The caller keeps the state and saves it.
 */
export function AppearanceChoices({name,kind,iconKey,colorKey,busy,onIcon,onColor,onReset}:{name?:string;kind:ClassificationKind;iconKey:string|null;colorKey:string|null;busy:boolean;onIcon(key:string):void;onColor(key:string):void;onReset():void}) {
  return <>
    <div className="album-look-preview"><ClassificationIcon kind={kind} iconKey={iconKey} style={{color:classificationColor(colorKey)}}/><span>{name}</span></div>
    <fieldset disabled={busy}><legend>아이콘</legend><div className="album-look-choices">{CLASSIFICATION_ICONS.map(choice=><Button key={choice.key} aria-label={choice.label} aria-pressed={iconKey===choice.key} onClick={()=>onIcon(choice.key)}><ClassificationIcon kind={kind} iconKey={choice.key}/>{choice.label}</Button>)}</div></fieldset>
    <fieldset disabled={busy}><legend>색상</legend><div className="album-look-choices">{CLASSIFICATION_COLORS.map(choice=><Button key={choice.key} aria-label={choice.label} aria-pressed={colorKey===choice.key} onClick={()=>onColor(choice.key)}><span aria-hidden="true" style={{color:choice.value}}>■</span>{choice.label}</Button>)}</div></fieldset>
    <Button disabled={busy} onClick={onReset}>기본값으로 초기화</Button>
  </>;
}
