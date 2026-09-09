import { useEffect, useState, type ReactNode } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Dialog } from "../shared/ui/Dialog";
import { Button } from "../shared/ui/Button";
import { TextField } from "../shared/ui/TextField";
import { commandErrorMessage } from "../library/errorMessage";
import type { CharacterTarget } from "./api";

type Group = { id: string; name: string; revision: number; targetIds: string[] };
export function CharacterGroups({ seriesId, members, children }: { seriesId: string; members: CharacterTarget[]; children: (members: CharacterTarget[]) => ReactNode }) {
  const [groups, setGroups] = useState<Group[]>([]);
  const [active, setActive] = useState<string | null>(null);
  const [draft, setDraft] = useState<Group | null>(null);
  const [busy, setBusy] = useState(false), [error, setError] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    let alive = true;
    void invoke<Group[]>("character_groups", { seriesId }).then(result => { if (alive) { setGroups(result); setError(null); } }).catch(error => { if (alive) setError(commandErrorMessage(error, "캐릭터 그룹을 불러오지 못했습니다.")); });
    return () => { alive = false; };
  }, [seriesId, revision]);
  const current = groups.find(group => group.id === active);
  const grouped = new Set(groups.flatMap(group => group.targetIds));
  async function save(remove = false) {
    if (!draft || busy) return;
    setBusy(true); setError(null);
    try {
      await invoke("save_character_group", { request: { id: draft.id || null, seriesId, expectedRevision: draft.id ? draft.revision : null, name: draft.name, targetIds: draft.targetIds, delete: remove } });
      setDraft(null); if (remove) setActive(null); setRevision(value => value + 1);
    } catch (error) { setError(commandErrorMessage(error, "그룹을 저장하지 못했습니다.")); }
    finally { setBusy(false); }
  }
  return <>
    <div className="series-gallery-heading"><h3>{current ? `캐릭터 그룹 · ${current.name}` : "캐릭터"}</h3>
      {current ? <><Button size="sm" variant="ghost" onClick={() => setActive(null)}>시리즈로</Button><Button size="sm" variant="ghost" onClick={() => setDraft({ ...current, targetIds: [...current.targetIds] })}>그룹 편집</Button></> : <Button size="sm" variant="ghost" onClick={() => setDraft({ id: "", name: "", revision: 0, targetIds: [] })}>그룹 만들기</Button>}
    </div>
    {error && <p role="alert">{error}<Button size="sm" onClick={() => setRevision(value => value + 1)}>다시 불러오기</Button></p>}
    {!current && groups.length > 0 && <div className="character-group-list">{groups.map(group => <Button key={group.id} variant="ghost" onClick={() => setActive(group.id)}>{group.name} · {group.targetIds.length}명</Button>)}</div>}
    {children(members.filter(target => current ? current.targetIds.includes(target.id) : !grouped.has(target.id)))}
    {draft && <Dialog open title={draft.id ? "캐릭터 그룹 편집" : "캐릭터 그룹 만들기"} onClose={() => { if (!busy) setDraft(null); }}>
      <TextField label="그룹 이름" value={draft.name} maxLength={100} disabled={busy} onChange={event => setDraft({ ...draft, name: event.target.value })} />
      <p>탐색 목록만 묶습니다. 시리즈 소속, 이미지 분류와 분석 범위는 바뀌지 않습니다.</p>
      <div className="character-group-members">{members.filter(target => !grouped.has(target.id) || groups.find(group => group.id === draft.id)?.targetIds.includes(target.id)).map(target => <label key={target.id}><input type="checkbox" disabled={busy} checked={draft.targetIds.includes(target.id)} onChange={event => setDraft({ ...draft, targetIds: event.target.checked ? [...draft.targetIds, target.id] : draft.targetIds.filter(id => id !== target.id) })} />{target.displayName}</label>)}</div>
      {error && <p role="alert">{error}</p>}
      <div className="character-actions"><Button disabled={busy || !draft.name.trim()} onClick={() => void save()}>저장</Button>{draft.id && <Button variant="ghost" disabled={busy} onClick={() => void save(true)}>그룹 해제 · 캐릭터 유지</Button>}</div>
    </Dialog>}
  </>;
}
