import {ClassificationIcon,classificationColor} from '../src/classification/classificationAppearance';
import {bindSheetItems,treeActionDefs} from '../src/shared/contextActions';
import {displayCount} from '../src/shared/displayDate';
import {ActionSheet} from './ActionSheet';
import {isOriginalsRoot} from './FolderManagement';
import {folderCardCount,type Entry} from './libraryModel';

/**
 * The long-press sheet of a plain folder (a card or a drawer row). The items are the shared folder list
 * minus what only the PC does (분류함으로 쓰기, 폴더 이동, 삭제). 고정 / 고정 해제 runs at once; the
 * others only choose: 폴더 관리 does the work.
 */
export function FolderActionSheet({folder,entries,pinned=false,onClose,onManage,onPin}:{folder:Entry;entries:readonly Entry[];/** The folder is in the shared pin list. */pinned?:boolean;onClose():void;onManage(mode:'create'|'rename'|'look'):void;onPin?():void}) {
  const children=entries.filter(item=>item.parent_id===folder.id).length;
  const items=bindSheetItems(treeActionDefs({kind:'folder',originalsRoot:isOriginalsRoot(folder),hasChildren:children>0,topLevel:!folder.parent_id,pinned}),{
    pin:onPin,
    'create-child':()=>onManage('create'),
    rename:()=>onManage('rename'),
    appearance:()=>onManage('look'),
  });
  const meta=[`분류 · ${displayCount(folderCardCount(folder),'장')}`,...(children?[`하위 폴더 ${displayCount(children)}`]:[])].join(' · ');
  return <ActionSheet onClose={onClose} items={items} target={{name:folder.name,meta,color:classificationColor(folder.color_key??null),thumb:<ClassificationIcon kind={folder.kind??'tag'} iconKey={folder.icon_key??null} testId={false}/>}}/>;
}
