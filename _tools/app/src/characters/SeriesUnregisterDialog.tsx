import { useEffect, useState } from "react";
import { commandErrorMessage } from "../library/errorMessage";
import { BusyLabel } from "../shared/ui/BusyLabel";
import { Button } from "../shared/ui/Button";
import { Dialog } from "../shared/ui/Dialog";
import { characterExtrasApi, type SeriesUnregisterPreview, type SeriesUnregisterResult } from "./extrasApi";
import "./CharacterExtras.css";

type UnregisterApi = Pick<typeof characterExtrasApi, "unregisterPreview" | "unregisterSeries">;

/** The sentence that says where a series' characters, groups and 기타 go. */
export function unregisterSummary(preview: SeriesUnregisterPreview) {
  const parts = [
    `캐릭터 ${preview.characterCount.toLocaleString("ko-KR")}명`,
    ...(preview.groupCount > 0 ? [`그룹 ${preview.groupCount.toLocaleString("ko-KR")}개`] : []),
    ...(preview.extrasImageCount > 0 ? [`기타 이미지 ${preview.extrasImageCount.toLocaleString("ko-KR")}장`] : []),
  ];
  if (!preview.destinationName) return "옮길 캐릭터가 없어 등록만 해제합니다.";
  return `${parts.join(" · ")}이 ‘${preview.destinationName}’ 시리즈로 옮겨집니다.`;
}

/**
 * 시리즈 등록 해제: shows where the characters go before anything changes. A collision or any other
 * refusal is shown as the reason and keeps the confirm button off. Closing after a success is the
 * owner's cue to reload (`onClose(result)`), so the result stays readable until then.
 */
export function SeriesUnregisterDialog({ seriesId, seriesName, api = characterExtrasApi, onClose }: {
  seriesId: string;
  seriesName: string;
  api?: UnregisterApi;
  /** `result` is set when the series was unregistered. */
  onClose: (result: SeriesUnregisterResult | null, preview: SeriesUnregisterPreview | null) => void;
}) {
  const [preview, setPreview] = useState<SeriesUnregisterPreview | null>(null);
  const [result, setResult] = useState<SeriesUnregisterResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let active = true;
    setPreview(null); setError(null);
    void api.unregisterPreview(seriesId).then(next => { if (active) setPreview(next); },
      reason => { if (active) setError(commandErrorMessage(reason, "등록 해제 내용을 확인하지 못했습니다.")); });
    return () => { active = false; };
  }, [api, seriesId]);
  const blocked = !preview || Boolean(preview.refusal) || preview.collisions.length > 0;

  async function confirm() {
    if (busy || blocked || result) return;
    setBusy(true); setError(null);
    try { setResult(await api.unregisterSeries(seriesId)); }
    catch (reason) { setError(commandErrorMessage(reason, "시리즈 등록을 해제하지 못했습니다.")); }
    finally { setBusy(false); }
  }

  return <Dialog open title="시리즈 등록 해제" variant="medium" onClose={() => { if (!busy) onClose(result, preview); }}>
    <div className="character-extras-dialog">
      <p className="character-extras-dialog__summary"><strong>{seriesName}</strong></p>
      <BusyLabel busy={!preview && !error}><p className="character-message" role="status">확인하는 중…</p></BusyLabel>
      {preview && !result && <>
        <p>{unregisterSummary(preview)}</p>
        <p className="character-extras-dialog__note">이미지와 폴더는 그대로 두고, 이 폴더는 일반 폴더가 됩니다.</p>
        {preview.collisions.length > 0 && !preview.refusal && <p className="character-message" role="alert">‘{preview.destinationName ?? "상위 시리즈"}’에 같은 이름이 이미 있습니다: {preview.collisions.join(", ")}</p>}
        {preview.refusal && <p className="character-message" role="alert">{preview.refusal}</p>}
      </>}
      {result && preview && <p role="status">{preview.destinationName ? `캐릭터 ${result.movedCharacterCount.toLocaleString("ko-KR")}명${result.movedGroupCount > 0 ? ` · 그룹 ${result.movedGroupCount.toLocaleString("ko-KR")}개` : ""}을 ‘${preview.destinationName}’로 옮겼어요.` : "시리즈 등록을 해제했어요."}</p>}
      {error && <p className="character-message" role="alert">{error}</p>}
      <div className="character-actions character-extras-dialog__actions">
        {result
          ? <Button variant="primary" onClick={() => onClose(result, preview)}>확인</Button>
          : <>
            <Button variant="ghost" disabled={busy} onClick={() => onClose(null, preview)}>취소</Button>
            <Button variant="primary" disabled={busy || blocked} onClick={() => void confirm()}>
              <BusyLabel busy={busy} idle="등록 해제">해제하는 중…</BusyLabel>
            </Button>
          </>}
      </div>
    </div>
  </Dialog>;
}
