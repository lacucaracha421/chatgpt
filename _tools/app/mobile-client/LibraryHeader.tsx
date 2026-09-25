import {AdjustmentsVerticalIcon} from '@heroicons/react/24/outline';
import {Button} from './ui';
import {TopBar} from './TopBar';
import {CharacterGlyph,type CharacterFolderKind} from './FolderCards';
export interface LibraryCrumb {id:string;name:string;onSelect():void}
/**
 * A folder or album level: the shared bar with Back, the path above the title, and 보기 옵션.
 * The options button stays quiet at the defaults; with `changed` settings it takes the PC's grey
 * "filter on" face and shows how many differ (the same rule as the Catalog 필터 chip).
 */
export function LibraryHeader({title,count,crumbs,onBack,onOptions,changed=0,kind}:{title:string;count?:number|string;crumbs:LibraryCrumb[];onBack():void;onOptions():void;changed?:number;/** A character folder shows its person/people glyph before the name. */kind?:CharacterFolderKind}) {
  return <TopBar className="library-header" back={{label:'뒤로',onClick:onBack}}
    crumbs={<nav className="library-breadcrumb" aria-label="현재 위치">{crumbs.map((crumb,i)=><span key={crumb.id}>{i>0&&<span aria-hidden="true">›</span>}<button onClick={crumb.onSelect}>{crumb.name}</button></span>)}</nav>}
    title={kind?<><CharacterGlyph kind={kind}/>{title}</>:title} count={count}
    actions={<Button type="button" size="icon" variant="ghost" className={`top-bar__options${changed?' is-changed':''}`} aria-label="보기 옵션" aria-description={changed?`기본과 다른 설정 ${changed}개`:undefined} onClick={onOptions}><AdjustmentsVerticalIcon aria-hidden="true"/>{changed>0&&<span className="top-bar__options-count numeric" aria-hidden="true">{changed}</span>}</Button>}/>;
}
