import {ArrowLeftIcon,EllipsisVerticalIcon} from '@heroicons/react/24/outline';
import {IconButton} from './ui';
export interface LibraryCrumb {id:string;name:string;onSelect():void}
export function LibraryHeader({title,count,crumbs,onBack,onOptions}:{title:string;count?:number|string;crumbs:LibraryCrumb[];onBack():void;onOptions():void}) {
  return <header className="library-header"><IconButton label="뒤로" icon={ArrowLeftIcon} onClick={onBack}/><div className="library-titles"><nav className="library-breadcrumb" aria-label="현재 위치">{crumbs.map((crumb,i)=><span key={crumb.id}>{i>0&&<span aria-hidden="true">›</span>}<button onClick={crumb.onSelect}>{crumb.name}</button></span>)}</nav><div className="library-title"><h1>{title}</h1>{count!==undefined&&<span className="numeric muted">{count}</span>}</div></div><IconButton label="보기 옵션" icon={EllipsisVerticalIcon} onClick={onOptions}/></header>;
}
