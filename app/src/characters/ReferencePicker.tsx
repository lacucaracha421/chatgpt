import { useRef, useState } from "react";
import { useSeriesImages } from "./useSeriesImages";
import { AssetGallery } from "../assets/AssetGallery";
import { thumbnailUrl } from "../assets/mediaUrl";
import { Dialog } from "../shared/ui/Dialog";
import { Button } from "../shared/ui/Button";
import { commandErrorMessage } from "../library/errorMessage";
import type { CharacterApi, CharacterTarget } from "./api";

export function ReferencePicker({ target, api, privacyMode, onSaved, onClose }: { target: CharacterTarget; api: CharacterApi; privacyMode: boolean; onSaved: (target: CharacterTarget) => void; onClose: () => void }) {
  const images = useSeriesImages(target.seriesClassificationId, target.id);
  const { items, cursor, load } = images;
  const [selected, setSelected] = useState<string[]>(target.references.flatMap(r => r.assetId ? [r.assetId] : []));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pending = useRef(false);
  const busy = saving || images.busy;
  function toggle(id: string) {
    setSelected(old => {
      if (old.includes(id)) return old.filter(value => value !== id);
      if (old.length === 5) { setError("기준 이미지는 최대 5장입니다. 먼저 한 장을 해제해 주세요."); return old; }
      setError(null); return [...old, id];
    });
  }
  async function save() {
    if (pending.current) return;
    pending.current = true; setSaving(true); setError(null);
    try { const saved = await api.refs(target.id, target.revision, selected); onSaved(saved); onClose(); }
    catch (e) { setError(commandErrorMessage(e, "기준 이미지가 바뀌었습니다. 창을 다시 열어 확인해 주세요.")); }
    finally { pending.current = false; setSaving(false); }
  }
  return <Dialog open title={`${target.displayName} · 기준 이미지`} variant="wide" onClose={onClose}>
    <div className="character-picker">
      <p>선택한 시리즈와 하위 폴더에서 서로 다른 이미지 5장을 고르세요. 다른 캐릭터의 이미지는 제외됩니다.</p>
      <div className="character-refs" aria-label="선택한 기준 이미지">{selected.map((id, i) => <button key={id} onClick={() => toggle(id)} disabled={busy} aria-label={`기준 이미지 ${i + 1} 해제`}><img className={privacyMode ? "character-private" : ""} src={thumbnailUrl(id)} alt="" /><span>{i + 1} ×</span></button>)}</div>
      {(error || images.error) && <p role="alert">{error || images.error}</p>}
      <div className="character-picker__gallery"><AssetGallery layout="masonry" groupDates={false} items={items.filter(a => a.media.kind === "image")} selectedAssetIds={new Set(selected)} privacyMode={privacyMode} onSelectionGesture={a => { if (!busy) toggle(a.id); }} targetRowHeight={160} /></div>
      <div className="character-actions"><Button disabled={busy} onClick={() => void images.importImages().then(ids => setSelected(old => [...new Set([...old, ...ids])].slice(0, 5)))}>파일에서 가져오기</Button><Button disabled={busy || !cursor} onClick={() => void load(cursor)}>더 불러오기</Button><span>{selected.length} / 5장</span><Button variant="primary" disabled={busy} onClick={() => void save()}>기준 이미지 저장</Button><Button onClick={onClose}>닫기</Button></div>
    </div>
  </Dialog>;
}
