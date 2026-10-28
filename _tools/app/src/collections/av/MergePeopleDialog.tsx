import {useEffect, useState, type ComponentType} from 'react';
import {Dialog} from '../../shared/ui/Dialog';
import {Button} from '../../shared/ui/Button';
import {BusyLabel} from '../../shared/ui/BusyLabel';
import {AvPickList} from '../avReview/AvDestination';
import type {ProfileSurfaceProps} from './PersonProfileEditor';
import '../avReview/avReview.css';

/** personId is the person kept, matching the other person authority commands. */
export type MergePeopleCommand = {commandType: 'mergePeople'; personId: string; removePersonId: string; expectedRevision: number; expectedRemoveRevision: number; workId?: never};
export type MergePerson = {id: string; displayName: string; nameJa?: string | null};
export type MergeSnapshot = {entityRevision: number; creditWorkCount: number};
function MergeDialog(props: ProfileSurfaceProps) { return <Dialog open variant="medium" {...props}/>; }

export function MergePeopleDialog({person, load, read, onMerge, onClose, surface: Surface = MergeDialog}: {
  person: MergePerson; load(): Promise<MergePerson[]>; read(id: string): Promise<MergeSnapshot>;
  onMerge(command: MergePeopleCommand): Promise<void>; onClose(): void; surface?: ComponentType<ProfileSurfaceProps>;
}) {
  const [people, setPeople] = useState<MergePerson[]>([]);
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<{person: MergePerson; keep: MergeSnapshot; remove: MergeSnapshot} | null>(null);
  const [busy, setBusy] = useState(false), [loading, setLoading] = useState(true), [error, setError] = useState('');
  useEffect(() => {
    let active = true;
    void load().then(rows => { if(active) setPeople(rows.filter(p => p.id !== person.id)); }, reason => { if(active) setError(String(reason)); })
      .finally(() => { if(active) setLoading(false); });
    return () => { active = false; };
  }, [load, person.id]);
  async function pick(id: string) {
    const other = people.find(p => p.id === id); if(!other || busy) return;
    setBusy(true); setError('');
    try {
      const [keep, remove] = await Promise.all([read(person.id), read(id)]);
      if (![keep.entityRevision, remove.entityRevision].every(r => Number.isSafeInteger(r) && r > 0)
        || !Number.isSafeInteger(remove.creditWorkCount) || remove.creditWorkCount < 0) throw new Error('배우 정보를 다시 확인해 주세요.');
      setSelected({person: other, keep, remove});
    } catch(reason) { setError(String(reason)); }
    finally { setBusy(false); }
  }
  async function merge() {
    if(!selected || busy) return;
    setBusy(true); setError('');
    try {
      await onMerge({commandType: 'mergePeople', personId: person.id, removePersonId: selected.person.id,
        expectedRevision: selected.keep.entityRevision, expectedRemoveRevision: selected.remove.entityRevision});
      onClose();
    } catch(reason) { setError(String(reason)); }
    finally { setBusy(false); }
  }
  const sameName = (p: MergePerson) => !!person.nameJa?.trim() && p.nameJa?.trim() === person.nameJa.trim();
  const matches = people.filter(p => `${p.displayName} ${p.nameJa ?? ''}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()))
    .sort((a,b) => Number(sameName(b))-Number(sameName(a)) || a.displayName.localeCompare(b.displayName, 'ko'));
  return <Surface title="다른 배우와 합치기" onClose={() => { if(!busy) onClose(); }}>
    <div className="person-profile-editor merge-people" aria-busy={busy || loading}>
      {selected ? <>
        <p>{selected.person.displayName}를 {person.displayName}로 합칩니다. {selected.person.displayName}의 작품 {selected.remove.creditWorkCount}편이 옮겨지고 {selected.person.displayName}는 사라집니다.</p>
        <Button disabled={busy} onClick={() => setSelected(null)}>다른 배우 선택</Button>
        <Button variant="primary" disabled={busy} onClick={() => void merge()}>합치기</Button>
      </> : <fieldset disabled={busy || loading} style={{border: 0, padding: 0, margin: 0}}>
        <AvPickList label="배우 이름 검색" query={query} onQuery={setQuery} items={matches.map(p => ({id: p.id, primary: p.displayName, secondary: p.nameJa}))} onPick={id => void pick(id)} empty={loading ? '' : '검색 결과 없음'}/>
      </fieldset>}
      <BusyLabel busy={busy || loading}><p role="status">확인 중</p></BusyLabel>
      {error && <p role="alert">{error}</p>}
      <Button disabled={busy} variant="ghost" onClick={onClose}>취소</Button>
    </div>
  </Surface>;
}
