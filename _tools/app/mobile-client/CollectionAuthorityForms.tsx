import {useEffect, useState} from 'react';
import {Badge, Button, Dialog, DialogDescription, Field, TextInput} from './ui';
import {KIND_LABEL} from '../src/collections/collectionFormat';
import type {CollectionDetail, CollectionKind} from './collectionModel';
import {createdWork, replaceCommand, type CommandIntent, type Fields, type WorkCommand} from './collectionCommandOutbox';
import type {useCollectionAuthority} from './useCollectionAuthority';
import {errorText} from './transport';
import './collectionAuthority.css';

type Authority = ReturnType<typeof useCollectionAuthority>;
export type WorkForm = {mode: 'create' | 'rename' | 'info'; type: CollectionKind; item?: CollectionDetail; retry?: CommandIntent};
// The existing PC basic-info form's fields and wording; AV provider/people editing stays in its later batch.
const fields: Record<CollectionKind, [string, string, 'text' | 'number' | 'date', number][]> = {
  game: [['developer', '개발사', 'text', 2000], ['publisher', '퍼블리셔', 'text', 2000], ['platforms', '플랫폼', 'text', 6000], ['releaseDate', '출시일', 'date', 100], ['externalScore', '외부 점수', 'number', 0]],
  manga: [['originalTitle', '원제', 'text', 2000], ['author', '작가', 'text', 2000], ['year', '출간 연도', 'number', 0]],
  movie: [['originalTitle', '원제', 'text', 2000], ['runtimeMinutes', '상영 시간(분)', 'number', 0], ['productionCompany', '제작사', 'text', 2000], ['director', '감독', 'text', 2000], ['year', '개봉 연도', 'number', 0]],
  av: [['originalTitle', '원제', 'text', 2000], ['productionCompany', '제작사', 'text', 2000], ['releaseDate', '출시일', 'date', 100], ['runtimeMinutes', '상영 시간(분)', 'number', 0]],
};
export function CollectionWorkForm({form, authority, onClose}: {form: WorkForm; authority: Authority; onClose(): void}) {
  const [type, setType] = useState(form.type);
  const [draft, setDraft] = useState<Record<string, string>>(() => Object.fromEntries([
    ['name', form.item?.name ?? ''], ...Object.keys(fields).flatMap(kind => fields[kind as CollectionKind].map(([key]) => [key, String((form.item as unknown as Fields | undefined)?.[key] ?? '')])),
  ]));
  const [error, setError] = useState('');
  const [operation, setOperation] = useState<string | null>(form.retry?.command.operationId ?? null);
  const intent = authority.rows.find(row => row.command.operationId === operation);
  const pending = intent?.state === 'pending';
  useEffect(() => { if (intent?.state === 'accepted') onClose(); }, [intent?.state, onClose]);
  const nameConflict = intent?.conflict?.code === 'nameConflict';
  const title = form.mode === 'create' ? '새 작품' : form.mode === 'rename' ? '이름 바꾸기' : '기본 정보 편집';
  const change = (key: string, value: string) => { setDraft(current => ({...current, [key]: value})); setError(''); };
  const save = () => {
    try {
      const values: Fields = {};
      if (form.mode !== 'info') {
        values.name = draft.name.trim();
        if (!values.name) throw new Error('이름을 입력해 주세요.');
        if ([...values.name].length > 120) throw new Error('이름은 120자까지 쓸 수 있습니다.');
      }
      if (form.mode !== 'rename') for (const [key, label, input, limit] of fields[type]) {
        const value = draft[key]?.trim() ?? '';
        if (input === 'number') {
          const number = value ? Number(value) : null;
          if (number !== null && (!Number.isSafeInteger(number) || number < (key === 'runtimeMinutes' ? 1 : 0))) throw new Error(`${label} 값을 확인해 주세요.`);
          values[key] = number;
        } else {
          if ([...value].length > limit) throw new Error(`${label}은 ${limit.toLocaleString()}자까지 쓸 수 있습니다.`);
          values[key] = value || null;
        }
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
    } catch (reason) { setError(errorText(reason)); }
  };
  return <Dialog open title={title} onClose={onClose}><DialogDescription className="sr-only">작품 정보를 저장합니다.</DialogDescription>
    <form className="library-sheet collection-authority-form" onSubmit={event => { event.preventDefault(); save(); }}>
      {form.mode === 'create' && <div role="group" aria-label="유형" className="collection-authority-types">{(['game', 'manga', 'movie', 'av'] as const).map(kind => <Button key={kind} type="button" aria-pressed={kind === type} disabled={pending} onClick={() => setType(kind)}>{KIND_LABEL[kind]}</Button>)}</div>}
      {form.mode !== 'info' && <Field label="이름" error={nameConflict ? '같은 종류에 같은 이름의 작품이 있습니다.' : undefined}><TextInput value={draft.name} maxLength={120} disabled={pending} onChange={event => change('name', event.target.value)}/></Field>}
      {form.mode !== 'rename' && fields[type].map(([key, label, input, limit]) => <Field key={key} label={label}><TextInput type={input} value={draft[key] ?? ''} maxLength={limit || undefined} min={input === 'number' ? key === 'runtimeMinutes' ? 1 : 0 : undefined} step={input === 'number' ? 1 : undefined} disabled={pending} onChange={event => change(key, event.target.value)}/></Field>)}
      {intent?.state === 'conflict' && !nameConflict && <p role="alert">다른 기기에서 작품 정보가 바뀌었거나 변경을 받지 못했습니다. 내용을 확인해 주세요.</p>}
      {pending && <Badge>대기</Badge>}{error && <p role="alert">{error}</p>}
      <div className="ui-dialog__actions"><Button type="button" onClick={onClose}>닫기</Button><Button type="submit" variant="primary" disabled={pending}>저장</Button></div>
    </form>
  </Dialog>;
}
export function AuthorityWorkActions({item, authority, onForm}: {item: CollectionDetail; authority: Authority; onForm(form: WorkForm): void}) {
  if (!authority.identity) return null;
  return <div className="collection-authority-actions"><Button variant="ghost" onClick={() => onForm({mode: 'rename', type: item.type, item})}>이름 바꾸기</Button><Button variant="ghost" onClick={() => onForm({mode: 'info', type: item.type, item})}>기본 정보 편집</Button>
    <AuthorityQueue authority={authority} workId={item.id} onForm={onForm} item={item}/></div>;
}
export function AuthorityQueue({authority, workId, item, onForm}: {authority: Authority; workId?: string; item?: CollectionDetail; onForm(form: WorkForm): void}) {
  if (!authority.identity) return null;
  const rows = authority.rows.filter(row => row.state !== 'accepted' && (workId ? row.command.workId === workId : row.command.commandType === 'createWork'));
  return <>{rows.map(row => <div key={row.command.operationId} className="collection-authority-queue"><Badge>{row.state === 'conflict' ? '충돌' : '대기'}</Badge>
    {!workId && <span>{row.command.commandType === 'createWork' ? row.command.name : ''}</span>}
    {row.state === 'conflict' && <>{(row.command.commandType==='createWork'||row.command.commandType==='updateWork'&&Object.keys(row.command.changes).some(key=>!['description','myScore','showcase','status','ownedPlatform'].includes(key)))&&<Button variant="ghost" onClick={() => {
      const created = createdWork(row);
      if (created) onForm({mode: 'create', type: created.type, item: created, retry: row});
      else if (item && row.command.commandType === 'updateWork') onForm({mode: 'name' in row.command.changes ? 'rename' : 'info', type: item.type, item: authority.work(item), retry: row});
    }}>확인</Button>}<Button variant="ghost" onClick={() => {
      if (row.command.commandType === 'createWork') authority.drop(row.command.workId);
      else replaceCommand(row.command.operationId, null);
    }}>버리기</Button></>}
  </div>)}</>;
}
