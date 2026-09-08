import { useEffect, useState } from "react";
import type { ClassificationEntry } from "../library/types";
import { Button } from "../shared/ui/Button";
import { TextField } from "../shared/ui/TextField";
import { Select } from "../shared/ui/Select";
import { thumbnailUrl } from "../assets/mediaUrl";
import { commandErrorMessage } from "../library/errorMessage";
import { ReferencePicker } from "./ReferencePicker";
import type { CharacterApi, CharacterTarget } from "./api";

export function CharacterRegistry({ api, target, seriesId, classifications, privacyMode, onSaved }: { api: CharacterApi; target: CharacterTarget | null; seriesId: string; classifications: ClassificationEntry[]; privacyMode: boolean; onSaved: (t: CharacterTarget) => void }) {
  const [name, setName] = useState("");
  const [linked, setLinked] = useState("");
  const [enabled, setEnabled] = useState(true);
  const [busy, setBusy] = useState(false);
  const [picker, setPicker] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { setName(target?.displayName ?? ""); setLinked(target?.linkedClassificationId ?? ""); setEnabled(target?.enabled ?? true); setError(null); }, [target?.id, target?.revision, seriesId]);
  async function save() {
    setBusy(true); setError(null);
    try { onSaved(await api.save({ id: target?.id ?? null, expectedRevision: target?.revision ?? null, seriesClassificationId: seriesId, linkedClassificationId: linked || null, displayName: name.trim(), enabled })); }
    catch (e) { setError(commandErrorMessage(e, "캐릭터를 저장하지 못했습니다.")); }
    finally { setBusy(false); }
  }
  return <section className="character-registry" aria-label="캐릭터 설정">
    <TextField label="캐릭터 이름" value={name} onChange={e => setName(e.target.value)} disabled={busy} />
    <Select label="관련 폴더 (선택)" value={linked} onChange={e => setLinked(e.target.value)} disabled={busy}><option value="">연결 안 함</option>{classifications.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}</Select>
    <label className="character-check"><input type="checkbox" checked={enabled} disabled={busy} onChange={e => setEnabled(e.target.checked)} />분석에 사용</label>
    <Button disabled={busy || !seriesId || !name.trim()} onClick={() => void save()}>{target ? "설정 저장" : "캐릭터 만들기"}</Button>
    {error && <p role="alert">{error}</p>}
    {target && <>
      <div className="character-refs" aria-label="기준 이미지">{target.references.map(r => <span key={r.slot} title={r.status === "ready" ? `기준 ${r.slot + 1}` : "이미지 확인 필요"}>{r.assetId ? <img className={privacyMode ? "character-private" : ""} src={thumbnailUrl(r.assetId)} alt={`기준 ${r.slot + 1}`} /> : <span>누락</span>}{r.status !== "ready" && <small>확인 필요</small>}</span>)}</div>
      <p>{target.ready ? "분석 준비됨 · 기준 5장" : `기준 ${target.references.length} / 5장${!target.enabled ? " · 비활성" : " · 확인 필요"}`}</p>
      <Button disabled={busy} onClick={() => setPicker(true)}>기준 이미지 선택</Button>
      {picker && <ReferencePicker key={`${target.id}:${target.revision}`} target={target} api={api} privacyMode={privacyMode} onSaved={onSaved} onClose={() => setPicker(false)} />}
    </>}
  </section>;
}
