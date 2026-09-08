import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { Dialog } from "../../shared/ui/Dialog";
import { Button } from "../../shared/ui/Button";
import { workArtworkThumbnailUrl, workArtworkUrl } from "../../assets/mediaUrl";
import { usePrivacy } from "../../privacy/PrivacyContext";
import { COVER_SURFACES, SURFACE_LABEL, type AvCoverSet, type CoverSurface } from "../avTypes";
import { attachLiveCase } from "./collectibleRuntime";

export function availableCoverStops(covers: AvCoverSet, failed: Partial<Record<CoverSurface, boolean>> = {}): CoverSurface[] {
  if (!covers.frontId || failed.front) return [];
  return COVER_SURFACES.filter(surface => covers[`${surface}Id`] && !failed[surface]);
}
function CaseSurface({ id, surface, scope, revision, onFailure }: { id: string; surface: CoverSurface; scope: string; revision: string; onFailure(): void }) {
  const host = useRef<HTMLDivElement>(null), [ready, setReady] = useState(false);
  useEffect(() => {
    if (!host.current) return;
    setReady(false);
    const live = attachLiveCase(host.current, { src: workArtworkThumbnailUrl(id), pose: surface, scope, revision }, value => { setReady(value); if (!value) onFailure(); });
    return () => live.dispose();
  }, [id, surface, scope, revision, onFailure]);
  return <div ref={host} className="complete-cover-viewer__canvas" role="img" aria-label={`${SURFACE_LABEL[surface]} 표지`} aria-busy={!ready} />;
}
export function CompleteCoverViewer({ title, covers, scope = "", onClose }: { title: string; covers: AvCoverSet; scope?: string; onClose(): void }) {
  const { privacyMode } = usePrivacy();
  const [surface, setSurface] = useState<CoverSurface>("front"), [flat, setFlat] = useState(false), [failed, setFailed] = useState<Partial<Record<CoverSurface, boolean>>>({});
  const stops = availableCoverStops(covers, failed);
  const current = stops.includes(surface) ? surface : "front", id = covers[`${current}Id`];
  const failureRef = useRef(() => {});
  failureRef.current = () => { setFailed(value => ({ ...value, [current]: true })); setSurface("front"); };
  const stableFailure = useRef(() => failureRef.current()).current;
  const originalFallback = useRef(() => setFlat(true)).current;
  function keys(event: KeyboardEvent<HTMLDivElement>) {
    if (event.target instanceof HTMLElement && event.target.matches("input,textarea,select")) return;
    if (!["ArrowLeft", "ArrowRight", "Home"].includes(event.key)) return;
    event.preventDefault(); event.stopPropagation();
    const next = event.key === "Home" ? "front" : stops[stops.indexOf(current) + (event.key === "ArrowRight" ? 1 : -1)];
    if (next && stops.includes(next)) setSurface(next);
  }
  return <Dialog open title={`${title} 표지 감상`} variant="wide" onClose={onClose} onKeyDown={keys}>
    <div className="complete-cover-viewer">
      <div className="complete-cover-viewer__stage">
        {privacyMode ? <span>비공개 모드</span> : !stops.length || !id ? <span>표지를 표시할 수 없습니다.</span> : flat ? <img src={workArtworkUrl(id)} alt={`${SURFACE_LABEL[current]} 원본`} onError={stableFailure} /> : <CaseSurface id={id} surface={current} scope={scope} revision={covers.revision} onFailure={originalFallback} />}
      </div>
      <div className="complete-cover-viewer__controls" role="group" aria-label="표지 면">{stops.map(stop => <Button key={stop} aria-pressed={current === stop} onClick={() => setSurface(stop)}>{SURFACE_LABEL[stop]}</Button>)}</div>
      <div className="ui-dialog__actions"><Button disabled={!stops.length || privacyMode} aria-pressed={flat} onClick={() => setFlat(value => !value)}>{flat ? "표지로 보기" : "원본 보기"}</Button><Button onClick={onClose}>닫기</Button></div>
    </div>
  </Dialog>;
}
