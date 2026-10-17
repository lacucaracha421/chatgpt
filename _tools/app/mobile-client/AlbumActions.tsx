import {ClassificationIcon,classificationColor} from '../src/classification/classificationAppearance';
import {bindSheetItems,treeActionDefs} from '../src/shared/contextActions';
import {displayCount} from '../src/shared/displayDate';
import {ActionSheet} from './ActionSheet';
import {Cover} from './CoverGroup';
import type {AlbumTree,NativeAlbum} from './albumModel';
import type {Asset} from './types';

export type AlbumManageMode='create'|'rename'|'look'|'delete';

/**
 * The long-press sheet of an album card or row: the shared album list minus 앨범 이동 (PC only). Choosing
 * an item opens 앨범 관리 on that form, which checks the rest (the 마음에 들어요 album and albums with
 * sub-albums cannot be deleted).
 */
export function AlbumActionSheet({tree,album,cover,onClose,onManage}:{tree:AlbumTree;album:NativeAlbum;cover?:Asset;onClose():void;onManage(mode:AlbumManageMode):void}) {
  const children=tree.albums.filter(item=>item.parentId===album.id&&item.id!==album.id).length;
  const items=bindSheetItems(treeActionDefs({kind:'album',hasChildren:children>0}),{
    'create-child':()=>onManage('create'),
    rename:()=>onManage('rename'),
    appearance:()=>onManage('look'),
    delete:()=>onManage('delete'),
  });
  const meta=['앨범',...(album.assetCount===undefined?[]:[displayCount(album.assetCount,'장')]),...(children?[`하위 앨범 ${displayCount(children)}`]:[])].join(' · ');
  return <ActionSheet onClose={onClose} items={items} target={cover
    ?{name:album.name,meta,thumb:<Cover asset={cover} paused={false}/>}
    :{name:album.name,meta,color:classificationColor(album.colorKey),thumb:<ClassificationIcon kind="root" iconKey={album.iconKey} testId={false}/>}}/>;
}
