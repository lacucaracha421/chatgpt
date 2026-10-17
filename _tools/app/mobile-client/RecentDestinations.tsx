import type {CSSProperties,ReactNode} from 'react';
import {CheckIcon,RectangleStackIcon} from '@heroicons/react/24/outline';
import {ClassificationIcon,classificationColor} from '../src/classification/classificationAppearance';
import {treeBreadcrumb} from './homeModel';
import {SectionLabel} from './ui';
import type {AssignmentClassification} from './ClassificationAssignmentEditor';
import type {MembershipAlbum} from './AlbumMembershipEditor';
import '../src/assets/recentFolders.css';
import './recentDestinations.css';

/** One place images can be put with a single tap. */
export type DestinationChip={id:string;name:string;parentName:string;path:string;icon:ReactNode;color?:string};

/** The recent folders that still exist in the assignable tree, newest first. Groups and characters are not classification targets. */
export function folderDestinationChips(ids:readonly string[],tree:readonly AssignmentClassification[]):DestinationChip[]{
  const byId=new Map(tree.map(row=>[row.id,row]));
  return ids.flatMap(id=>{
    const row=byId.get(id);
    if(!row)return [];
    return [{id,name:row.name,parentName:row.parentId?byId.get(row.parentId)?.name??'':'',path:treeBreadcrumb(row,tree),
      icon:<ClassificationIcon kind={row.kind} iconKey={row.iconKey} testId={false}/>,color:classificationColor(row.colorKey)}];
  });
}

export function albumDestinationChips(ids:readonly string[],albums:readonly MembershipAlbum[]):DestinationChip[]{
  const byId=new Map(albums.map(album=>[album.id,album]));
  return ids.flatMap(id=>{
    const album=byId.get(id);
    if(!album)return [];
    return [{id,name:album.name,parentName:album.parentId?byId.get(album.parentId)?.name??'':'',path:album.name,icon:<RectangleStackIcon aria-hidden="true"/>}];
  });
}

/**
 * The 최근 row at the top of the 분류 and 앨범 sheets and the viewer's 분류 editor. A tap applies at once;
 * the chip then shows a check in place (the sheet closes itself shortly after). A destination that already
 * holds every selected image stays visible but cannot be picked. No history, no row.
 */
export function RecentDestinations({chips,label,doneId,disabledIds,status,onPick}:{
  chips:readonly DestinationChip[];label:string;doneId:string|null;disabledIds:ReadonlySet<string>;status:string;onPick(chip:DestinationChip):void;
}){
  if(!chips.length)return null;
  return <section className="recent-destinations">
    <SectionLabel title="최근" actions={<span className="recent-destinations__status" role="status">{status}</span>}/>
    <div className="recent-row" role="group" aria-label={label}>
      {chips.map(chip=>{
        const done=chip.id===doneId,unavailable=!done&&disabledIds.has(chip.id);
        return <button key={chip.id} type="button" className={`ui-button ui-button--quiet ui-button--md recent-folders__chip${done?' is-done':''}`}
          style={{'--folder-color':chip.color} as CSSProperties} aria-disabled={unavailable||undefined} aria-description={chip.path}
          onClick={()=>{if(!unavailable&&!doneId)onPick(chip);}}>
          {done?<CheckIcon aria-hidden="true"/>:chip.icon}
          <span>{chip.parentName&&chips.some(other=>other.id!==chip.id&&other.name===chip.name)&&<span className="recent-folders__parent">{chip.parentName} › </span>}{chip.name}</span>
        </button>;
      })}
    </div>
  </section>;
}
