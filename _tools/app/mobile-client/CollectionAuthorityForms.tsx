import {useEffect, useState} from 'react';
import {Badge, Button, Dialog, DialogDescription, Field, SegmentedControl, TextInput} from './ui';
import {BusyLabel} from '../src/shared/ui/BusyLabel';
import {COLLECTION_CREATE_TYPES, COLLECTION_EDIT_FIELDS, COLLECTION_EDIT_INPUT, COLLECTION_NAME_MAX, COLLECTION_NAME_REQUIRED, collectionCreateLabel,
  collectionEditDraft, collectionEditError, collectionEditValue} from '../src/collections/collectionEditFields';
import type {CollectionDetail, CollectionKind} from './collectionModel';
import {createdWork, discardLifecycle, isLifecycle, lifecycleInFlight, replaceCommand, retryCommandNow, type CommandIntent, type Fields, type WorkCommand} from './collectionCommandOutbox';
import type {useCollectionAuthority} from './useCollectionAuthority';
import {errorText} from './transport';
import './collectionAuthority.css';

type Authority = ReturnType<typeof useCollectionAuthority>;
/** 새 컬렉션, or 컬렉션 편집: the name and the PC dialog's basic-info fields, saved as one updateWork. */
export type WorkForm = {mode: 'create' | 'edit'; type: CollectionKind; item?: CollectionDetail; retry?: CommandIntent};
// createWork accepts these four types; a TV series is a movie work with a TMDB binding, so 시리즈 is not offered.
const createTypes = COLLECTION_CREATE_TYPES.filter((value): value is CollectionKind => value !== 'tv').map(value => ({value, label: collectionCreateLabel(value)}));
export function CollectionWorkForm({form, authority, onClose, onCreated}: {form: WorkForm; authority: Authority; onClose(): void; onCreated?(id: string, type: CollectionKind): void}) {
  const [type, setType] = useState(form.type ?? 'game');
  const [draft, setDraft] = useState<Record<string, string>>(() => Object.fromEntries([
    ['name', form.item?.name ?? ''], ['description', form.item?.description ?? ''], ...Object.entries(collectionEditDraft(form.item as Fields | undefined)),
  ]));
  const [error, setError] = useState('');
  const [operation, setOperation] = useState<string | null>(form.retry?.command.operationId ?? null);
  const intent = authority.rows.find(row => row.command.operationId === operation);
  const pending = intent?.state === 'pending';
  useEffect(() => { if (intent?.state === 'accepted') onClose(); }, [intent?.state, onClose]);
  const nameConflict = intent?.conflict?.code === 'nameConflict';
  const title = form.mode === 'create' ? '새 컬렉션' : '컬렉션 편집';
  const change = (key: string, value: string) => { setDraft(current => ({...current, [key]: value})); setError(''); };
  const save = () => {
    try {
      const values: Fields = {};
      values.name = draft.name.trim();
      if (!values.name) throw new Error(COLLECTION_NAME_REQUIRED);
      if ([...values.name].length > COLLECTION_NAME_MAX) throw new Error(`이름은 ${COLLECTION_NAME_MAX}자까지 쓸 수 있습니다.`);
      if (form.mode === 'create') {
        const description = draft.description.trim();
        if ([...description].length > 2000) throw new Error('설명은 2,000자까지 쓸 수 있습니다.');
        values.description = description || null;
      }
      if (form.mode === 'edit') for (const field of COLLECTION_EDIT_FIELDS[type]) {
        const invalid = collectionEditError(field, draft[field.key] ?? '');
        if (invalid) throw new Error(invalid);
        values[field.key] = collectionEditValue(field, draft[field.key] ?? '');
      }
      let command: WorkCommand;
      if (form.mode === 'create') {
        const {name, ...basic} = values;
        command = {commandType: 'createWork', workId: form.retry?.command.workId ?? crypto.randomUUID(), type, name: name as string, fields: basic, legacyKind: null, binding: null};
      } else {
        const base = form.item as unknown as Fields;
        const current = intent?.conflict?.current?.work;
        const expected: Fields = {}, changes: Fields = {};
        for (const [key, value] of Object.entries(values)) {
          const rejected = intent?.state === 'conflict' && intent.command.commandType === 'updateWork' ? intent.command : null;
          // Reconfirm only this draft's touched fields, preserving unrelated remote changes.
          if (rejected && !(key in rejected.changes) && Object.is(value, base[key] ?? null)) continue;
          const previous = current ? key === 'name' ? current.name : current.fields[key] ?? null
            : rejected && key in rejected.expected ? rejected.expected[key] : base[key] ?? null;
          if (!Object.is(value, previous)) { changes[key] = value; expected[key] = previous; }
        }
        if (!Object.keys(changes).length) { if (intent?.state === 'conflict') replaceCommand(intent.command.operationId, null); onClose(); return; }
        command = {commandType: 'updateWork', workId: form.item!.id, changes, expected, expectedRevision: null};
      }
      if (intent?.state === 'conflict') {
        const replacement = replaceCommand(intent.command.operationId, command); setOperation(replacement?.command.operationId ?? null); void authority.flush();
      } else setOperation(authority.enqueue(command).command.operationId);
      if (form.mode === 'create') { onClose(); onCreated?.(command.workId, type); }
    } catch (reason) { setError(errorText(reason)); }
  };
  return <Dialog open title={title} onClose={onClose}><DialogDescription className="sr-only">작품 정보를 저장합니다.</DialogDescription>
    <form className={`library-sheet collection-authority-form${form.mode === 'create' ? ' collection-create-form' : ''}`} onSubmit={event => { event.preventDefault(); if (!pending) save(); }}>
      <Field label="이름" error={nameConflict ? '같은 종류에 같은 이름의 작품이 있습니다.' : undefined}><TextInput value={draft.name} maxLength={COLLECTION_NAME_MAX} disabled={pending} onChange={event => change('name', event.target.value)}/></Field>
      {form.mode === 'create' && <><Field label="설명"><TextInput value={draft.description} maxLength={2000} disabled={pending} onChange={event => change('description', event.target.value)}/></Field>
        <SegmentedControl label="유형" fullWidth options={createTypes} value={type} onChange={setType}/></>}
      {form.mode === 'edit' && COLLECTION_EDIT_FIELDS[type].map(field => <Field key={field.key} label={field.label}><TextInput {...COLLECTION_EDIT_INPUT[field.control]} value={draft[field.key] ?? ''} maxLength={field.maxLength} disabled={pending} onChange={event => change(field.key, event.target.value)}/></Field>)}
      {intent?.state === 'conflict' && !nameConflict && <p role="alert">다른 기기에서 작품 정보가 바뀌었거나 변경을 받지 못했습니다. 내용을 확인해 주세요.</p>}
      <BusyLabel busy={pending} idle=""><Badge>대기</Badge></BusyLabel>{error && <p role="alert">{error}</p>}
      <div className="ui-dialog__actions"><Button type="button" variant={form.mode === 'create' ? 'quiet' : 'secondary'} onClick={onClose}>{form.mode === 'create' ? '취소' : '닫기'}</Button><Button type="submit" variant="primary" disabled={pending || form.mode === 'create' && !draft.name.trim()}>저장</Button></div>
    </form>
  </Dialog>;
}
export function AuthorityQueue({authority, workId, item, onForm}: {authority: Authority; workId?: string; item?: CollectionDetail; onForm(form: WorkForm): void}) {
  if (!authority.identity) return null;
  // The shelf lists the rows whose work it cannot open: creations, provider adds, deletes and restores.
  const rows = authority.rows.filter(row => row.state !== 'accepted' && (workId ? row.command.workId === workId : row.command.commandType === 'createWork'
    || row.command.commandType === 'providerApply' && row.command.operation === 'create' || row.command.commandType === 'deleteWork' || row.command.commandType === 'restoreWork'));
  return <>{rows.map(row => <div key={row.command.operationId} className="collection-authority-queue"><Badge>{row.state === 'conflict' ? '충돌' : '대기'}</Badge>
    {!workId && <span>{row.command.commandType === 'createWork' ? row.command.name : row.command.commandType === 'providerApply' ? `${row.command.provider.toUpperCase()}에서 추가`
      : row.command.commandType === 'deleteWork' ? `${row.label ?? '작품'} 삭제` : row.command.commandType === 'restoreWork' ? `${row.label ?? '작품'} 되살리기` : ''}</span>}
    {row.state === 'conflict' && <>{(row.command.commandType==='createWork'||row.command.commandType==='updateWork'&&Object.keys(row.command.changes).some(key=>!['description','myScore','showcase','status','ownedPlatform'].includes(key)))&&<Button variant="ghost" onClick={() => {
      const created = createdWork(row);
      if (created) onForm({mode: 'create', type: created.type, item: created, retry: row});
      else if (item && row.command.commandType === 'updateWork') onForm({mode: 'edit', type: item.type, item: authority.work(item), retry: row});
    }}>확인</Button>}<Button variant="ghost" onClick={() => {
      if (row.command.commandType === 'createWork') authority.drop(row.command.workId);
      else replaceCommand(row.command.operationId, null);
    }}>버리기</Button></>}
    {/* A delete or restore that is not on its way says why and can be sent again or dropped. */}
    {row.state === 'pending' && isLifecycle(row.command) && !lifecycleInFlight(row) && <>
      {row.lastError && <small className="collection-authority-queue__reason">{row.lastError}</small>}
      <Button variant="ghost" onClick={() => { retryCommandNow(row.command.operationId); void authority.flush(); }}>다시 시도</Button>
      <Button variant="ghost" onClick={() => discardLifecycle(row.command.operationId)}>버리기</Button></>}
  </div>)}</>;
}
