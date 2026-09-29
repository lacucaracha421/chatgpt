import { useState } from "react";
import { workArtworkThumbnailUrl, workArtworkUrl } from "../../assets/mediaUrl";
import { Button } from "../../shared/ui/Button";
import { Dialog } from "../../shared/ui/Dialog";
import { usePrivacy } from "../../privacy/PrivacyContext";
import type { AvCoverSet } from "../avTypes";
import { DvdCase } from "./DvdCase";
import "./avViewer.css";

function revisioned(id: string, revision: string) { return `${workArtworkUrl(id)}?v=${encodeURIComponent(revision)}`; }

export function AvViewer({ title, covers, onClose }: { title: string; covers: AvCoverSet; onClose(): void }) {
  const { privacyMode } = usePrivacy();
  const [flat, setFlat] = useState(false);
  const [original, setOriginal] = useState(false);

  return <Dialog open title={`${title} 표지 감상`} variant="wide" onClose={onClose}>
    <div className="av-viewer">
      <div className="av-viewer__stage">
        {flat ? <FlatJacket covers={covers} original={original} /> : <DvdCase frontArtworkId={covers.frontId} spineArtworkId={covers.spineId} backArtworkId={covers.backId} revision={covers.revision} interactive large restingAngle={0} size={560} alt={`${title} DVD 케이스`} />}
        {privacyMode && <span className="av-viewer__privacy">비공개 모드</span>}
      </div>
      <div className="av-viewer__controls" role="group" aria-label="케이스 면">
        <Button aria-pressed={!flat} onClick={() => setFlat(false)}>입체</Button>
        <Button aria-pressed={flat} onClick={() => setFlat(true)}>펼침</Button>
        <span className="av-viewer__spacer" />
        <span className="av-viewer__hint">좌우로 드래그해 돌리기 · ←/→ 조금씩 · Home 앞면 · Esc 닫기</span>
      </div>
      <div className="ui-dialog__actions">{flat && <Button disabled={privacyMode} aria-pressed={original} onClick={() => setOriginal(value => !value)}>원본 보기</Button>}<Button onClick={onClose}>닫기</Button></div>
    </div>
  </Dialog>;
}

function FlatJacket({ covers, original }: { covers: AvCoverSet; original: boolean }) {
  const { privacyMode } = usePrivacy();
  return <div className="av-viewer__flat" aria-label="펼친 재킷">
    {(["back", "spine", "front"] as const).map(surface => {
      const id = covers[`${surface}Id`];
      return <div key={surface} className={`av-viewer__flat-surface av-viewer__flat-surface--${surface}`}>
        {id && !privacyMode && <img src={original ? revisioned(id, covers.revision) : `${workArtworkThumbnailUrl(id)}?v=${encodeURIComponent(covers.revision)}`} alt={`${surface === "front" ? "앞면" : surface === "spine" ? "책등" : "뒷면"}`} draggable={false} />}
      </div>;
    })}
  </div>;
}
