import {useEffect, useMemo, useState} from 'react';
import {Select} from '../src/shared/ui/Select';
import limits from '../src/collections/avLimits.json';
import {Badge, Button, Dialog, DialogDescription, Field, TextInput} from './ui';
import {AV_DETAIL_FIELDS, AV_EDIT_TITLE, AV_INPUT_ERROR, avCredits, avValue, canonicalAvCredits, orderedPeople, sameAvValue, sameCreditList, validateAvCredits, validateAvDetails, type AvDetailFields, type AvDetailKey} from './avEditModel';
import {replaceCommand, type CommandIntent, type WorkCommand} from './collectionCommandOutbox';
import type {AvPerson, CollectionDetail, CollectionSummary} from './collectionModel';
import type {useCollectionAuthority} from './useCollectionAuthority';
import {errorText} from './transport';
import './collectionAuthority.css';

type Authority = ReturnType<typeof useCollectionAuthority>;
export function AvWorkEditSheet({item, confirmed, items, entityRevision, refreshing, authority, retry, onClose}: {
  item: CollectionDetail; confirmed: CollectionDetail; items: CollectionSummary[]; entityRevision?: number | null; refreshing: boolean;
  authority: Authority; retry?: CommandIntent; onClose(): void;
}) {
  // An open draft retains the exact read it started from; a remote edit is caught by CAS.
  const [base] = useState(() => ({av: confirmed.av, visibleAv: item.av, revision: entityRevision}));
  const [draft, setDraft] = useState<Record<AvDetailKey, string>>(() => Object.fromEntries(AV_DETAIL_FIELDS.map(({key}) => [key,
    key === 'genres' ? (item.av?.genres ?? []).join(', ') : item.av?.[key] ?? ''])) as Record<AvDetailKey, string>);
  const [people, setPeople] = useState(() => (item.av?.people ?? []).slice().sort((a,b) => a.role === b.role ? a.order-b.order : a.role === 'performer' ? -1 : 1));
  const [newIds, setNewIds] = useState(() => new Set(retry?.command.commandType === 'setAvCredits' ? retry.command.people.map(person => person.personId) : []));
  const [query, setQuery] = useState(''), [role, setRole] = useState<AvPerson['role']>('performer'), [error, setError] = useState('');
  const [operations, setOperations] = useState<string[]>([]);
  const ownRows = operations.flatMap(id => { const row = authority.rows.find(row => row.command.operationId === id) ?? authority.acknowledgements.find(row => row.command.operationId === id); return row ? [row] : []; });
  const pending = authority.rows.some(row => row.command.workId === item.id && row.state === 'pending');
  const conflict = ownRows.some(row => row.state === 'conflict');
  // A rejected command can be reconfirmed even while its dependent rows wait behind it.
  const preceding = retry ? authority.rows.slice(0, authority.rows.findIndex(row => row.command.operationId === retry.command.operationId)) : authority.rows;
  const otherChanges = preceding.some(row => row.command.workId === item.id && row.state !== 'accepted' && !operations.includes(row.command.operationId));
  const locked = operations.length > 0 || otherChanges;
  useEffect(() => { if (operations.length && ownRows.length === operations.length && ownRows.every(row => row.state === 'accepted')) onClose(); }, [operations, ownRows, onClose]);
  const known = useMemo(() => {
    const byId = new Map<string, AvPerson>();
    for (const work of [...items, confirmed]) for (const person of work.av?.people ?? []) byId.set(person.id, person);
    return [...byId.values()];
  }, [items, confirmed]);
  const results = query.trim() ? known.filter(person => `${person.name} ${person.nameJa ?? ''}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase())) : [];
  const add = (person?: AvPerson) => {
    if (locked) return;
    if (people.length >= limits.credits || !query.trim() || [...query.trim()].length > limits.personName) { setError(AV_INPUT_ERROR); return; }
    if (person && people.some(credit => credit.id === person.id && credit.role === role)) { setError('이미 같은 역할로 연결된 인물입니다.'); return; }
    const id = person?.id ?? crypto.randomUUID();
    if (!person) setNewIds(current => new Set([...current, id]));
    setPeople(current => [...current, {...person, id, name: person?.name ?? query.trim(), nameJa: person?.nameJa ?? null, role, order: 0, creditName: null}]);
    setQuery(''); setError('');
  };
  const move = (index: number, direction: -1 | 1) => {
    const positions = people.flatMap((person, position) => person.role === people[index].role ? [position] : []);
    const target = positions[positions.indexOf(index) + direction];
    if (target === undefined) return;
    setPeople(current => { const next = [...current]; [next[index], next[target]] = [next[target], next[index]]; return next; });
  };
  const save = () => {
    if (locked || refreshing) return;
    try {
      const rejected = retry?.command;
      const remote = retry?.conflict?.current?.work;
      if (retry && !remote) throw new Error('정보가 변경되었습니다. 다시 불러온 뒤 저장해 주세요.');
      const values: AvDetailFields = {}, changes: AvDetailFields = {}, expected: AvDetailFields = {};
      for (const {key} of AV_DETAIL_FIELDS) values[key] = key === 'genres'
        ? draft.genres === (base.visibleAv?.genres ?? []).join(', ') ? base.visibleAv?.genres ?? [] : draft.genres.split(/[,\n]/).map(value => value.trim()).filter(Boolean)
        : draft[key].trim() || null;
      validateAvDetails(values);
      for (const {key} of AV_DETAIL_FIELDS) {
        if (rejected && (rejected.commandType !== 'setAvDetails' || !(key in rejected.changes))) continue;
        const previous = avValue(remote?.details?.av ?? base.av, key);
        if (!sameAvValue(values[key], previous)) { changes[key] = values[key]; expected[key] = previous; }
      }
      const nextPeople = orderedPeople(people), credits = avCredits(nextPeople);
      const previousCredits = rejected?.commandType === 'setAvCredits' ? canonicalAvCredits(remote?.avCredits ?? []) : avCredits(base.av?.people ?? []);
      const creditsChanged = (!rejected || rejected.commandType === 'setAvCredits') && !sameCreditList(credits, previousCredits);
      const commands: WorkCommand[] = [];
      // Credits use the read revision first. Details use field CAS, so the credits bump
      // cannot cause a conflict when both are saved together.
      if (creditsChanged) {
        const revision = rejected?.commandType === 'setAvCredits' ? remote?.entityRevision : base.revision;
        if (revision == null) throw new Error('정보가 변경되었습니다. 다시 불러온 뒤 저장해 주세요.');
        const added = [...new Set(nextPeople.filter(person => newIds.has(person.id) && !known.some(knownPerson => knownPerson.id === person.id)).map(person => person.id))]
          .map(personId => { const person = nextPeople.find(person => person.id === personId)!; return {personId, displayName: person.name.trim(), nameJa: person.nameJa?.trim() || null}; });
        validateAvCredits(credits, added, revision);
        commands.push({commandType: 'setAvCredits', workId: item.id, credits, people: added, expectedRevision: revision});
      }
      if (Object.keys(changes).length) commands.push({commandType: 'setAvDetails', workId: item.id, changes, expected});
      if (!commands.length) { if (retry) { replaceCommand(retry.command.operationId, null); void authority.flush(); } onClose(); return; }
      const overlay = {people: nextPeople, expectedCredits: previousCredits};
      if (retry) {
        const row = replaceCommand(retry.command.operationId, commands[0], overlay);
        if (row) { setOperations([row.command.operationId]); void authority.flush(); }
      } else setOperations(authority.enqueueBatch(commands, overlay).map(row => row.command.operationId));
      setError('');
    } catch (reason) { setError(errorText(reason)); }
  };
  return <Dialog open title={AV_EDIT_TITLE} onClose={onClose}><DialogDescription className="sr-only">작품 정보와 출연 · 감독을 저장합니다.</DialogDescription>
    <form className="library-sheet collection-authority-form av-work-edit" onSubmit={event => { event.preventDefault(); save(); }}>
      {AV_DETAIL_FIELDS.map(field => <Field key={field.key} label={field.label}><TextInput value={draft[field.key]} maxLength={field.maxLength} disabled={locked || !!retry && (retry.command.commandType !== 'setAvDetails' || !(field.key in retry.command.changes))}
        placeholder={field.key === 'genres' ? '쉼표로 구분' : field.key === 'releaseDate' ? 'YYYY-MM-DD' : undefined}
        onChange={event => { setDraft(current => ({...current, [field.key]: event.target.value})); setError(''); }}/></Field>)}
      <div className="av-work-edit__add"><Select label="역할" value={role} disabled={locked || !!retry && retry.command.commandType !== 'setAvCredits'} onChange={event => setRole(event.target.value as AvPerson['role'])}><option value="performer">출연</option><option value="director">감독</option></Select>
        <Field label="인물 이름 검색"><TextInput value={query} maxLength={limits.personName} disabled={locked || !!retry && retry.command.commandType !== 'setAvCredits'} onChange={event => { setQuery(event.target.value); setError(''); }}/></Field>
        {query.trim() && <Button type="button" disabled={locked || people.length >= limits.credits} onClick={() => add()}>새 인물로 추가</Button>}
        {!!results.length && <ul aria-label="기존 인물">{results.map(person => <li key={person.id}><Button type="button" disabled={locked || people.length >= limits.credits} onClick={() => add(person)}>{person.name} · {person.id.slice(0, 8)}</Button></li>)}</ul>}
      </div>
      {(['performer', 'director'] as const).map(creditRole => <section key={creditRole} aria-label={creditRole === 'performer' ? '출연자' : '감독'}><h3>{creditRole === 'performer' ? '출연자' : '감독'}</h3>
        {people.map((person, index) => person.role !== creditRole ? null : <div key={`${person.role}/${person.id}`} className="av-work-edit__person"><strong>{person.name}</strong>
          <Field label={`${person.name} 작품 내 표기`}><TextInput maxLength={limits.creditName} value={person.creditName ?? ''} disabled={locked || !!retry && retry.command.commandType !== 'setAvCredits'} onChange={event => setPeople(current => current.map((entry, at) => at === index ? {...entry, creditName: event.target.value} : entry))}/></Field>
          <div className="av-work-edit__actions"><Button type="button" aria-label={`${person.name} 위로`} disabled={locked || !!retry && retry.command.commandType !== 'setAvCredits' || !people.slice(0,index).some(entry => entry.role === creditRole)} onClick={() => move(index, -1)}>위</Button>
            <Button type="button" aria-label={`${person.name} 아래로`} disabled={locked || !!retry && retry.command.commandType !== 'setAvCredits' || !people.slice(index+1).some(entry => entry.role === creditRole)} onClick={() => move(index, 1)}>아래</Button>
            <Button type="button" aria-label={`${person.name} 연결 제거`} disabled={locked || !!retry && retry.command.commandType !== 'setAvCredits'} onClick={() => setPeople(current => current.filter((_,at) => at !== index))}>제거</Button></div>
        </div>)}
      </section>)}
      {pending && <Badge>대기</Badge>}
      {(conflict || otherChanges || refreshing) && <p role="alert">{conflict ? '다른 기기에서 작품 정보가 바뀌었거나 변경을 받지 못했습니다. 내용을 확인해 주세요.' : otherChanges ? '처리되지 않은 변경이 있습니다' : '작품 정보를 다시 불러오는 중입니다'}</p>}
      {error && <p role="alert">{error}</p>}
      <div className="ui-dialog__actions"><Button type="button" onClick={onClose}>닫기</Button><Button type="submit" variant="primary" disabled={locked || refreshing}>저장</Button></div>
    </form>
  </Dialog>;
}
