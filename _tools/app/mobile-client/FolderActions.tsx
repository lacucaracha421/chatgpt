import {ClassificationIcon,classificationColor} from '../src/classification/classificationAppearance';
import {bindSheetItems,treeActionDefs} from '../src/shared/contextActions';
import {displayCount} from '../src/shared/displayDate';
import {ActionSheet} from './ActionSheet';
import {isOriginalsRoot} from './FolderManagement';
import {folderCardCount,type Entry} from './libraryModel';

/**
 * The long-press sheet of a plain folder card. The items are the shared folder list minus what only the
 * PC does (분류함으로 쓰기, 폴더 이동, 삭제); 고정 and 아이콘 및 색상 are left out until the tablet can write
 * them. The sheet only chooses: 폴더 관리 does the work.
 */
export function FolderActionSheet({folder,entries,onClose,onManage}:{folder:Entry;entries:readonly Entry[];onClose():void;onManage(mode:'create'|'rename'):void}) {
  const children=entries.filter(item=>item.parent_id===folder.id).length;
  const items=bindSheetItems(treeActionDefs({kind:'folder',originalsRoot:isOriginalsRoot(folder),hasChildren:children>0,topLevel:!folder.parent_id}),{
    'create-child':()=>onManage('create'),
    rename:()=>onManage('rename'),
  });
  const meta=[`분류 · ${displayCount(folderCardCount(folder),'장')}`,...(children?[`하위 폴더 ${displayCount(children)}`]:[])].join(' · ');
  return <ActionSheet onClose={onClose} items={items} target={{name:folder.name,meta,color:classificationColor(folder.color_key??null),thumb:<ClassificationIcon kind={folder.kind??'tag'} iconKey={folder.icon_key??null} testId={false}/>}}/>;
}
