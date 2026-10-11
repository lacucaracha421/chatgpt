import { useState } from "react";
import { commandErrorMessage } from "../library/errorMessage";
import { BusyLabel } from "../shared/ui/BusyLabel";
import { Button } from "../shared/ui/Button";
import { Dialog } from "../shared/ui/Dialog";
import { RECOGNITION_REFERENCES, type ExtrasPromotionOutcome } from "./ExtrasPromotionDialog";
import { characterHubApi, type CharacterHubApi } from "./hubApi";
import "./CharacterExtras.css";

/**
 * What 캐릭터로 did: the new character, how many images moved and whether recognition is on.
 * Nothing compares older images by itself, so the 과거 미분류 이미지 갱신 button is offered here.
 */
export function ExtrasPromotionDone({ outcome, api = characterHubApi, onOpen, onClose }: {
  outcome: ExtrasPromotionOutcome;
  api?: Pick<CharacterHubApi, "requestReferenceRefresh">;
  onOpen: () => void;
  onClose: () => void;
}) {
  const { result, groupNote } = outcome;
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function refreshOlder() {
    if (busy) return;
    setBusy(true); setError(null);
    try {
      const receipt = await api.requestReferenceRefresh(result.target.id, result.target.revision);
      setMessage(receipt.eligibleCount > 0
        ? `미분류 이미지 ${receipt.eligibleCount.toLocaleString("ko-KR")}개 갱신을 예약했습니다. 작업 센터에서 진행 상황을 확인할 수 있습니다.`
        : receipt.state === "completed" ? "갱신할 미분류 이미지가 없습니다." : "갱신 대상을 확인하고 있습니다. 작업 센터에서 진행 상황을 확인할 수 있습니다.");
    } catch (reason) {
      setError(commandErrorMessage(reason, "과거 이미지 갱신을 예약하지 못했습니다."));
    } finally { setBusy(false); }
  }

  return <Dialog open title="캐릭터를 만들었어요" variant="medium" onClose={onClose}>
    <div className="character-extras-dialog">
      <p className="character-extras-dialog__summary"><strong>{result.target.displayName}</strong></p>
      <ul className="character-extras-dialog__facts">
        <li>기타에서 {result.movedCount.toLocaleString("ko-KR")}장을 옮겼어요.</li>
        <li>{result.recognition ? "자동 인식 켜짐" : `수동으로 시작 (레퍼런스 ${result.referenceCount.toLocaleString("ko-KR")}/${RECOGNITION_REFERENCES})`}</li>
      </ul>
      {groupNote && <p className="character-message" role="alert">{groupNote}</p>}
      {message && <p className="character-message" role="status">{message}</p>}
      {error && <p className="character-message" role="alert">{error}</p>}
      <div className="character-actions character-extras-dialog__actions">
        {result.recognition && !message && <Button variant="secondary" disabled={busy} onClick={() => void refreshOlder()}>
          <BusyLabel busy={busy} idle="과거 미분류 이미지 갱신">예약하는 중…</BusyLabel>
        </Button>}
        <Button variant="ghost" onClick={onClose}>닫기</Button>
        <Button variant="primary" onClick={onOpen}>캐릭터 열기</Button>
      </div>
    </div>
  </Dialog>;
}
