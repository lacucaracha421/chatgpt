import {useRef} from 'react';
import {bindSheetItems,collectionActionDefs} from '../src/shared/contextActions';
import {ActionSheet} from './ActionSheet';
import {useCoverUrl} from './collectionArtwork';
import {collectionCardCredit,collectionCardDate,collectionCover,type CollectionSummary} from './collectionModel';
import {KIND_LABEL} from '../src/collections/collectionFormat';

function Thumb({work,revision,privacy}:{work:CollectionSummary;revision:string;privacy:boolean}) {
  const host=useRef<HTMLSpanElement>(null);
  const url=useCoverUrl(work,collectionCover(work),revision,!privacy,host);
  return <span ref={host} className="home-cover">{privacy?<span className="privacy-mask" aria-label="비공개 모드"/>:url&&<img src={url} alt="" draggable={false}/>}</span>;
}

/**
 * The long-press sheet of a work on the shelf (cover, spine or manga row): the shared work list with
 * 휴지통으로 last. Each item is offered only when the tablet can run it for this work.
 */
export function CollectionActionSheet({work,revision,privacy,showcase,canEdit,canShowcase,onClose,onEdit,onShowcase,onTrash}:{work:CollectionSummary;revision:string;privacy:boolean;showcase:boolean;canEdit:boolean;canShowcase:boolean;onClose():void;onEdit():void;onShowcase():void;onTrash():void}) {
  const items=bindSheetItems(collectionActionDefs({showcase}),{
    edit:canEdit?onEdit:undefined,
    showcase:canShowcase?onShowcase:undefined,
    delete:canEdit?onTrash:undefined,
  });
  const meta=[KIND_LABEL[work.type],collectionCardCredit(work),collectionCardDate(work)].filter(Boolean).join(' · ');
  return <ActionSheet onClose={onClose} items={items} target={{name:work.name,meta,thumb:<Thumb work={work} revision={revision} privacy={privacy}/>}}/>;
}
