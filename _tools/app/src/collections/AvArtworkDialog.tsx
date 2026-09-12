import { useEffect, useRef, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { Dialog } from "../shared/ui/Dialog";
import { Button } from "../shared/ui/Button";
import { workArtworkThumbnailUrl } from "../assets/mediaUrl";
import { usePrivacy } from "../privacy/PrivacyContext";
import { avError } from "./avClient";
import { COVER_SURFACES, SURFACE_LABEL, type ArtworkDecision, type AvCoverSet, type AvGateway, type CoverSurface, type LocalArtworkPreview } from "./avTypes";

export function AvArtworkDialog({ collectionId, covers, api, onClose, onSaved }: {
  collectionId: string; covers: AvCoverSet; api: AvGateway; onClose(): void; onSaved(value: AvCoverSet): void;
}) {
  const { privacyMode } = usePrivacy();
  const [decisions, setDecisions] = useState<Record<CoverSurface, ArtworkDecision>>({ front: { kind: "keep" }, spine: { kind: "keep" }, back: { kind: "keep" } });
  const [previews, setPreviews] = useState<Partial<Record<CoverSurface, LocalArtworkPreview>>>({});
  const [busy, setBusy] = useState(false), [error, setError] = useState<string | null>(null);
  const active = useRef(true);
  useEffect(() => { active.current = true; return () => { active.current = false; }; }, []);
  async function pick(surface: CoverSurface) {
    setBusy(true); setError(null);
    try {
      const path = await open({ multiple: false, directory: false, filters: [{ name: "표지 이미지", extensions: ["jpg", "jpeg", "png", "webp"] }] });
      if (!active.current || typeof path !== "string") return;
      const preview = await api.previewArtwork(path, surface);
      if (!active.current) return;
      setPreviews(value => ({ ...value, [surface]: preview }));
      setDecisions(value => ({ ...value, [surface]: { kind: "local", path, sha256: preview.sha256 } }));
    } catch (reason) { if (active.current) setError(avError(reason)); } finally { if (active.current) setBusy(false); }
  }
  async function apply() {
    setBusy(true); setError(null);
    try { const saved = await api.applyArtwork(collectionId, { expectedRevision: covers.revision, ...decisions }); if (active.current) { onSaved(saved); onClose(); } }
    catch (reason) { if (active.current) setError(avError(reason)); } finally { if (active.current) setBusy(false); }
  }
  return <Dialog open title="표지 앞면·책등·뒷면" variant="wide" onClose={() => { if (!busy) onClose(); }}>
    <div className="av-artwork-editor">{COVER_SURFACES.map(surface => {
      const id = covers[`${surface}Id`], decision = decisions[surface];
      const url = decision.kind === "clear" ? null : decision.kind === "local" ? previews[surface]?.thumbnailDataUrl : id ? workArtworkThumbnailUrl(id) : null;
      return <section key={surface} aria-label={SURFACE_LABEL[surface]}><h3>{SURFACE_LABEL[surface]}</h3>
        <div className="av-artwork-preview">{url && !privacyMode ? <img src={url} alt={`${SURFACE_LABEL[surface]} 미리보기`} /> : <span>{privacyMode ? "비공개 모드" : "이미지 없음"}</span>}</div>
        <Button disabled={busy} onClick={() => void pick(surface)}>{SURFACE_LABEL[surface]} 파일 선택</Button>
        <Button disabled={busy} onClick={() => setDecisions(value => ({ ...value, [surface]: { kind: "clear" } }))}>선택 해제</Button>
        {decision.kind !== "keep" && <Button disabled={busy} onClick={() => setDecisions(value => ({ ...value, [surface]: { kind: "keep" } }))}>기존 선택 유지</Button>}
      </section>;
    })}</div>
    {error && <p role="alert">{error}</p>}
    <div className="ui-dialog__actions"><Button disabled={busy} onClick={onClose}>취소</Button><Button variant="primary" disabled={busy} onClick={() => void apply()}>적용</Button></div>
  </Dialog>;
}
