import { useEffect, useRef, useState } from "react";
import { useLibrary } from "../library/LibraryContext";
import type { AssetCursor, AssetSummary } from "../library/types";
import { AssetGallery } from "../assets/AssetGallery";
import { thumbnailUrl } from "../assets/mediaUrl";
import { Dialog } from "../shared/ui/Dialog";
import { Button } from "../shared/ui/Button";
import { commandErrorMessage } from "../library/errorMessage";
import type { CharacterApi, CharacterTarget } from "./api";

export function ReferencePicker({ target, api, privacyMode, onSaved, onClose }: { target: CharacterTarget; api: CharacterApi; privacyMode: boolean; onSaved: (target: CharacterTarget) => void; onClose: () => void }) {
  const { gateway } = useLibrary();
  const [items, setItems] = useState<AssetSummary[]>([]);
  const [cursor, setCursor] = useState<AssetCursor | null>(null);
  const [selected, setSelected] = useState<string[]>(target.references.flatMap(r => r.assetId ? [r.assetId] : []));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const active = useRef(true);
  const pending = useRef(false);
  async function load(after: AssetCursor | null) {
    if (pending.current || !target.seriesClassificationId) return;
    pending.current = true; setBusy(true); setError(null);
    try {
      const page = await gateway.listAssets({ classificationId: target.seriesClassificationId, albumId: null, collectionId: null, directOnly: false, unclassifiedOnly: false, mediaKind: "images", aspectRatio: null, sort: "newest", randomPivot: null, after, limit: 100 });
      if (active.current) { setItems(old => after ? [...old, ...page.items.filter(a => !old.some(b => b.id === a.id))] : page.items); setCursor(page.nextCursor); }
    } catch (e) { if (active.current) setError(commandErrorMessage(e, "기준 이미지를 불러오지 못했습니다.")); }
    finally { pending.current = false; if (active.current) setBusy(false); }
  }
  useEffect(() => { active.current = true; void load(null); return () => { active.current = false; }; }, []);
  function toggle(id: string) {
    setSelected(old => {
      if (old.includes(id)) return old.filter(value => value !== id);
      if (old.length === 5) { setError("기준 이미지는 최대 5장입니다. 먼저 한 장을 해제해 주세요."); return old; }
      setError(null); return [...old, id];
    });
  }
  async function save() {
    if (pending.current) return;
    pending.current = true; setBusy(true); setError(null);
    try { const saved = await api.refs(target.id, target.revision, selected); onSaved(saved); if (active.current) onClose(); }
    catch (e) { if (active.current) setError(commandErrorMessage(e, "기준 이미지가 바뀌었습니다. 창을 다시 열어 확인해 주세요.")); }
    finally { pending.current = false; if (active.current) setBusy(false); }
  }
  return <Dialog open title={`${target.displayName} · 기준 이미지`} variant="wide" onClose={onClose}>
    <div className="character-picker">
      <p>선택한 시리즈와 하위 폴더에서 서로 다른 이미지 5장을 고르세요.</p>
      <div className="character-refs" aria-label="선택한 기준 이미지">{selected.map((id, i) => <button key={id} onClick={() => toggle(id)} disabled={busy} aria-label={`기준 이미지 ${i + 1} 해제`}><img className={privacyMode ? "character-private" : ""} src={thumbnailUrl(id)} alt="" /><span>{i + 1} ×</span></button>)}</div>
      {error && <p role="alert">{error}</p>}
      <div className="character-picker__gallery"><AssetGallery layout="masonry" groupDates={false} items={items.filter(a => a.media.kind === "image")} selectedAssetIds={new Set(selected)} privacyMode={privacyMode} onSelectionGesture={a => { if (!busy) toggle(a.id); }} targetRowHeight={160} /></div>
      <div className="character-actions"><Button disabled={busy || !cursor} onClick={() => void load(cursor)}>더 불러오기</Button><span>{selected.length} / 5장</span><Button variant="primary" disabled={busy} onClick={() => void save()}>기준 이미지 저장</Button><Button onClick={onClose}>닫기</Button></div>
    </div>
  </Dialog>;
}
