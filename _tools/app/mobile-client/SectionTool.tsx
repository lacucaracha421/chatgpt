import type {ComponentType, SVGProps} from 'react';
import {Button} from './ui';

/** The same section action in both orientations; only its visible label changes. */
export function SectionTool({label,ariaLabel,icon:Icon,count,selected,onClick}:{label:string;ariaLabel?:string;icon:ComponentType<SVGProps<SVGSVGElement>>;count?:number;selected?:boolean;onClick():void}) {
  return <Button type="button" size="sm" variant="quiet" className={`section-tool${selected?' is-selected':''}`} aria-label={ariaLabel??(count===undefined?label:`${label} ${count.toLocaleString('ko-KR')}`)} aria-pressed={selected} onClick={onClick}><Icon aria-hidden="true"/><span className="section-tool__label">{label}</span>{count!==undefined&&<span className={`numeric section-tool__count${count>0?' is-new':''}`}>{count.toLocaleString('ko-KR')}</span>}</Button>;
}
