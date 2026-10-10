import {useState, type ComponentType, type SVGProps} from 'react';
import {ArrowPathIcon, EllipsisHorizontalIcon, LinkIcon, PencilSquareIcon, PhotoIcon, TrashIcon} from '@heroicons/react/24/outline';
import {BottomSheet} from './BottomSheet';
import {Button, Dialog, DialogDescription, IconButton} from './ui';
import {ProviderArtworkSheet, ProviderSearchSheet, useProviderBinding, type ProviderStatusState} from './CollectionProviders';
import {artworkLabel, providerName} from './collectionProviderModel';
import type {CollectionDetail, CollectionSummary} from './collectionModel';
import type {CommandIntent} from './collectionCommandOutbox';
import {AV_EDIT_TITLE} from './avEditModel';
import {AvWorkEditSheet} from './AvWorkEditSheet';
import type {WorkForm} from './CollectionAuthorityForms';
import type {useCollectionAuthority} from './useCollectionAuthority';
import {errorText} from './transport';
import './collectionAuthority.css';

type Authority = ReturnType<typeof useCollectionAuthority>;
/** The 작품 관리 menu, or the form or sheet one of its rows opened. */
export type ManageSheet = 'menu' | 'delete' | 'search' | 'artwork' | 'av' | null;

/** The work detail's top-bar ⋯: one place for everything the PC's 작품 관리 menu offers. */
export function WorkManageButton({onOpen}: {onOpen(): void}) {
  return <IconButton label="작품 관리" icon={EllipsisHorizontalIcon} onClick={onOpen}/>;
}

function ManageRow({icon: Icon, label, detail, danger = false, disabled = false, onClick}: {icon: ComponentType<SVGProps<SVGSVGElement>>; label: string; detail?: string | null; danger?: boolean; disabled?: boolean; onClick(): void}) {
  return <button type="button" className={`sheet-option collection-manage-row${danger ? ' is-danger' : ''}`} disabled={disabled} onClick={onClick}>
    <Icon aria-hidden="true"/><span className="collection-manage-row__text"><span>{label}</span>{detail && <small>{detail}</small>}</span>
  </button>;
}

/**
 * 작품 관리 for the open work: 컬렉션 편집, the provider rows its type supports, and 컬렉션 삭제.
 * Mounted while the work is open; the provider binding is read only once 작품 관리 opens; `sheet` is owned by the
 * screen so Back closes the innermost layer. `entityRevision` is the revision the shown detail
 * was read at, which the delete expects; `refreshing` while a change confirmed since then has
 * not been read back yet.
 */
export function WorkManage({item, confirmed = item, items = [], avRetry, authority, status, active, entityRevision, refreshing = false, searchKind = 'movie', sheet, onSheet, onForm, onDeleted}: {item: CollectionDetail; confirmed?: CollectionDetail; items?: CollectionSummary[]; avRetry?: CommandIntent; authority: Authority; status: ProviderStatusState; active: boolean;
  entityRevision?: number | null; refreshing?: boolean; searchKind?: 'movie' | 'tv'; sheet: ManageSheet; onSheet(sheet: ManageSheet): void; onForm(form: WorkForm): void; onDeleted(workId: string): void}) {
  const binding = useProviderBinding(item, authority, status, active && sheet !== null);
  const [failure, setFailure] = useState('');
  const close = () => { setFailure(''); onSheet(null); };
  const provider = binding.provider, name = provider ? providerName(provider) : '';
  // A delete expects the revision the detail showed; changes still in the queue would move it.
  const queued = authority.rows.some(row => row.command.workId === item.id && row.state !== 'accepted');
  const deleteBlocked = queued ? '처리되지 않은 변경이 있습니다' : refreshing ? '작품 정보를 다시 불러오는 중입니다'
    : entityRevision == null ? '서버를 업데이트하면 삭제할 수 있습니다' : null;
  // A failed binding read keeps its row usable as the retry.
  const connectBlocked = binding.failure && binding.blocked === binding.failure ? null : binding.blocked;
  const connectText = binding.failure && binding.blocked === binding.failure ? null : binding.blockedText;
  const act = (run: () => void) => { try { run(); } catch (reason) { setFailure(errorText(reason)); } };
  const remove = () => act(() => {
    authority.enqueue({commandType: 'deleteWork', workId: item.id, expectedRevision: entityRevision!}, item.name);
    close(); onDeleted(item.id);
  });
  return <>
    {sheet === 'menu' && <BottomSheet title="작품 관리" onClose={close}>
      <div className="collection-manage-group" role="group" aria-label="편집">
        <ManageRow icon={PencilSquareIcon} label="컬렉션 편집" onClick={() => { close(); onForm({mode: 'edit', type: item.type, item}); }}/>
        {item.type === 'av' && <ManageRow icon={PencilSquareIcon} label={AV_EDIT_TITLE} onClick={() => onSheet('av')}/>}
      </div>
      {provider && <div className="collection-manage-group" role="group" aria-label="외부 정보">
        <ManageRow icon={binding.externalId ? ArrowPathIcon : LinkIcon} label={binding.externalId ? `${name} 새로고침` : `${name}에 연결`}
          detail={binding.failure && !connectBlocked ? `${binding.failure} · 눌러서 다시 확인` : connectText} disabled={!!connectBlocked}
          onClick={() => binding.failure ? binding.retry() : binding.externalId ? act(() => { binding.refresh(); close(); }) : onSheet('search')}/>
        <ManageRow icon={PhotoIcon} label={artworkLabel(provider)} disabled={!!binding.blocked || !binding.externalId}
          detail={binding.blockedText ?? (binding.blocked || binding.externalId ? null : `${name}에 연결하면 이미지를 고를 수 있습니다.`)} onClick={() => onSheet('artwork')}/>
      </div>}
      <div className="collection-manage-group" role="group" aria-label="삭제">
        <ManageRow icon={TrashIcon} label="컬렉션 삭제" danger disabled={!!deleteBlocked} detail={deleteBlocked} onClick={() => onSheet('delete')}/>
      </div>
      {failure && <p role="alert" className="collection-manage-failure">{failure}</p>}
    </BottomSheet>}
    {sheet === 'delete' && <Dialog open title="컬렉션 삭제" onClose={close}>
      <div className="library-sheet collection-delete">
        <DialogDescription>{item.name} 컬렉션을 삭제하시겠습니까? 원본 에셋은 삭제하지 않습니다. 30일 동안 휴지통에서 되살릴 수 있어요.</DialogDescription>
        {failure && <p role="alert" className="collection-manage-failure">{failure}</p>}
        <div className="ui-dialog__actions"><Button onClick={close}>취소</Button><Button variant="danger" disabled={!!deleteBlocked} onClick={remove}>삭제</Button></div>
      </div>
    </Dialog>}
    {sheet === 'search' && provider && <ProviderSearchSheet item={item} provider={provider} authority={authority} initialKind={searchKind} onClose={close}/>}
    {sheet === 'artwork' && provider && binding.externalId && <ProviderArtworkSheet item={item} provider={provider} externalId={binding.externalId} authority={authority} onClose={close}/>}
    {sheet === 'av' && item.type === 'av' && <AvWorkEditSheet item={item} confirmed={confirmed} items={items} entityRevision={entityRevision} refreshing={refreshing} authority={authority} retry={avRetry} onClose={close}/>}
  </>;
}
