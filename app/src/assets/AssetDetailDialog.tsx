import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useLibrary } from "../library/LibraryContext";
import { commandErrorMessage } from "../library/errorMessage";
import type { AssetSummary, ClassificationEntry } from "../library/types";
import { Button } from "../shared/ui/Button";
import { Dialog } from "../shared/ui/Dialog";
import { Toast } from "../shared/ui/Toast";
import { assetUrl } from "./mediaUrl";

export function AssetDetailDialog({ asset, classifications, onClose, onTrashed }: { asset: AssetSummary | null; classifications: ClassificationEntry[]; onClose: () => void; onTrashed?: (assetId: string) => void }) {
  const { gateway } = useLibrary();
  const [state, setState] = useState({ assetId: null as string | null, status: "idle" as "idle" | "loading" | "loaded" | "error", selectedIds: [] as string[] });
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const identityRef = useRef({ assetId: null as string | null, generation: 0 });
  const assetId = asset?.id ?? null;
  useLayoutEffect(() => { identityRef.current = { assetId, generation: identityRef.current.generation + 1 }; return () => { if (identityRef.current.assetId === assetId) identityRef.current = { assetId: null, generation: identityRef.current.generation + 1 }; }; }, [assetId]);
  useEffect(() => {
    const request = { assetId, generation: identityRef.current.generation + 1 };
    identityRef.current = request; setState({ assetId, status: assetId ? "loading" : "idle", selectedIds: [] }); setSaving(false); setMessage(null);
    if (assetId) void gateway.getAssetClassifications(assetId).then((selectedIds) => { if (current(identityRef, request)) setState({ assetId, status: "loaded", selectedIds }); }).catch((error: unknown) => { if (current(identityRef, request)) { setState({ assetId, status: "error", selectedIds: [] }); setMessage(commandErrorMessage(error, "분류를 불러오지 못했습니다.")); } });
    return () => { if (current(identityRef, request)) identityRef.current = { assetId: null, generation: identityRef.current.generation + 1 }; };
  }, [assetId, gateway]);
  if (!asset) return null;
  const loaded = state.assetId === asset.id && state.status === "loaded";
  const selectedIds = state.assetId === asset.id ? state.selectedIds : [];
  const close = () => { identityRef.current = { assetId: null, generation: identityRef.current.generation + 1 }; onClose(); };
  const save = async () => {
    if (!loaded || saving) return;
    const request = { assetId: asset.id, generation: identityRef.current.generation }; setSaving(true); setMessage(null);
    try { await gateway.setAssetClassifications(asset.id, classifications.filter((entry) => selectedIds.includes(entry.id)).map((entry) => entry.id)); if (current(identityRef, request)) close(); }
    catch (error) { if (current(identityRef, request)) setMessage(commandErrorMessage(error, "분류를 저장하지 못했습니다.")); }
    finally { if (current(identityRef, request)) setSaving(false); }
  };
  const trash = async () => {
    if (saving) return;
    setSaving(true); setMessage(null);
    try {
      await gateway.trashAsset(asset.id);
      onTrashed?.(asset.id);
      close();
    } catch (error) {
      setMessage(commandErrorMessage(error, "자산을 휴지통으로 이동하지 못했습니다."));
    } finally {
      setSaving(false);
    }
  };
  const date = localDate(asset.collectedAt);
  return <Dialog open title={asset.title || asset.originalName} onClose={close}><div className="asset-detail">
    <img className="asset-detail__image" src={assetUrl(asset.id)} alt={asset.title || asset.originalName} />
    <dl className="asset-detail__metadata"><div><dt>출처</dt><dd>{asset.sourceUrl ?? "—"}</dd></div><div><dt>가져온 날짜</dt><dd>{date ?? "—"}</dd></div><div><dt>좋아요</dt><dd>{asset.favorite ? "예" : "아니요"}</dd></div></dl>
    <fieldset disabled={!loaded || saving} className="asset-detail__classifications"><legend>분류</legend>{classifications.map((entry) => <label key={entry.id}><input type="checkbox" checked={selectedIds.includes(entry.id)} onChange={(event) => setState((value) => ({ ...value, selectedIds: event.target.checked ? [...value.selectedIds, entry.id] : value.selectedIds.filter((id) => id !== entry.id) }))} />{entry.name}</label>)}</fieldset>
    {message && <Toast>{message}</Toast>}<div className="ui-dialog__actions"><Button type="button" onClick={close}>닫기</Button><Button type="button" variant="danger" disabled={saving} onClick={() => void trash()}>휴지통으로 이동</Button><Button type="button" disabled={!loaded || saving} onClick={() => void save()}>분류 저장</Button></div>
  </div></Dialog>;
}

function current(ref: React.RefObject<{ assetId: string | null; generation: number }>, request: { assetId: string | null; generation: number }) { return ref.current?.assetId === request.assetId && ref.current.generation === request.generation; }
function localDate(value: string) { const date = new Date(value); return Number.isNaN(date.getTime()) ? null : date.toLocaleDateString(); }
