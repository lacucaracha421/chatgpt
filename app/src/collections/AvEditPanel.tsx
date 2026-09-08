import { useEffect, useRef, useState } from "react";
import { Dialog } from "../shared/ui/Dialog";
import { Button } from "../shared/ui/Button";
import { TextField } from "../shared/ui/TextField";
import { Select } from "../shared/ui/Select";
import { avError } from "./avClient";
import type { AvDetails, AvGateway, AvPerson, AvPersonInput, AvPersonRole } from "./avTypes";

type CreditDraft = AvPersonInput & { key: string; displayName: string };
export function AvEditPanel({ details, api, onClose, onSaved }: {
  details: AvDetails; api: AvGateway; onClose(): void; onSaved(value: AvDetails): void;
}) {
  const [code, setCode] = useState(details.productCode ?? ""), [label, setLabel] = useState(details.label ?? ""), [series, setSeries] = useState(details.series ?? "");
  const [people, setPeople] = useState<CreditDraft[]>(() => details.people.map(person => ({ key: `${person.role}/${person.id}`, displayName: person.displayName, person: { kind: "existing", id: person.id }, role: person.role, creditName: person.creditName })));
  const [query, setQuery] = useState(""), [role, setRole] = useState<AvPersonRole>("performer");
  const [results, setResults] = useState<AvPerson[]>([]), [error, setError] = useState<string | null>(null), [saving, setSaving] = useState(false);
  const active = useRef(true);
  useEffect(() => { active.current = true; return () => { active.current = false; }; }, []);
  useEffect(() => {
    let active = true;
    setResults([]);
    if (!query.trim()) return;
    const timer = setTimeout(() => { void api.searchPeople(query).then(value => { if (active) setResults(value); }, reason => { if (active) setError(avError(reason)); }); }, 180);
    return () => { active = false; clearTimeout(timer); };
  }, [query, api]);
  function add(person?: AvPerson) {
    const displayName = person?.displayName ?? query.trim();
    if (!displayName || people.length >= 100) return;
    if (person && people.some(item => item.person.kind === "existing" && item.person.id === person.id && item.role === role)) { setError("이미 같은 역할로 연결된 인물입니다."); return; }
    setPeople(items => [...items, { key: crypto.randomUUID(), displayName, person: person ? { kind: "existing", id: person.id } : { kind: "new", displayName }, role, creditName: null }]);
    setQuery(""); setError(null);
  }
  function move(index: number, direction: -1 | 1) {
    const target = people.map((person, position) => person.role === people[index].role ? position : -1).filter(position => position >= 0);
    const next = target[target.indexOf(index) + direction];
    if (next === undefined) return;
    setPeople(items => { const copy = [...items]; [copy[index], copy[next]] = [copy[next], copy[index]]; return copy; });
  }
  async function save() {
    setSaving(true); setError(null);
    try {
      const saved = await api.saveDetails(details.collectionId, { expectedRevision: details.revision, productCode: code.trim() || null, label: label.trim() || null, series: series.trim() || null, people: people.map(({ person, role: creditRole, creditName }) => ({ person, role: creditRole, creditName: creditName?.trim() || null })) });
      if (active.current) { onSaved(saved); onClose(); }
    } catch (reason) { if (active.current) setError(avError(reason)); } finally { if (active.current) setSaving(false); }
  }
  return <Dialog open title="AV 정보 편집" variant="medium" onClose={() => { if (!saving) onClose(); }}>
    <div className="av-edit-panel">
      <TextField label="품번" maxLength={120} value={code} onChange={event => setCode(event.target.value)} />
      <TextField label="레이블" maxLength={240} value={label} onChange={event => setLabel(event.target.value)} />
      <TextField label="시리즈" maxLength={240} value={series} onChange={event => setSeries(event.target.value)} />
      <div className="av-people-add"><Select label="역할" value={role} onChange={event => setRole(event.target.value as AvPersonRole)}><option value="performer">출연</option><option value="director">감독</option></Select>
        <TextField label="인물 이름 검색" maxLength={120} value={query} onChange={event => setQuery(event.target.value)} />
        {query.trim() && <Button disabled={saving || people.length >= 100} onClick={() => add()}>새 인물로 추가</Button>}
        {results.length > 0 && <ul aria-label="기존 인물">{results.map(person => <li key={person.id}><Button disabled={saving} onClick={() => add(person)}>{person.displayName} · {person.id.slice(0, 8)}</Button></li>)}</ul>}
      </div>
      {(["performer", "director"] as const).map(creditRole => <section key={creditRole} aria-label={creditRole === "performer" ? "출연자" : "감독"}>
        <h3>{creditRole === "performer" ? "출연자" : "감독"}</h3>
        {people.map((person, index) => person.role !== creditRole ? null : <div key={person.key} className="av-person-row">
          <span>{person.displayName}</span>
          <TextField label={`${person.displayName} 작품 내 표기`} maxLength={120} value={person.creditName ?? ""} onChange={event => setPeople(items => items.map((item, position) => position === index ? { ...item, creditName: event.target.value } : item))} />
          <Button aria-label={`${person.displayName} 위로`} disabled={saving || !people.slice(0, index).some(item => item.role === creditRole)} onClick={() => move(index, -1)}>위</Button>
          <Button aria-label={`${person.displayName} 아래로`} disabled={saving || !people.slice(index + 1).some(item => item.role === creditRole)} onClick={() => move(index, 1)}>아래</Button>
          <Button disabled={saving} aria-label={`${person.displayName} 연결 해제`} onClick={() => setPeople(items => items.filter((_, position) => position !== index))}>해제</Button>
        </div>)}
      </section>)}
      {error && <p role="alert">{error}</p>}
      <div className="ui-dialog__actions"><Button disabled={saving} onClick={onClose}>취소</Button><Button variant="primary" disabled={saving} onClick={() => void save()}>저장</Button></div>
    </div>
  </Dialog>;
}
