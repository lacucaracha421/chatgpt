import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Button } from "../shared/ui/Button";
import { Dialog } from "../shared/ui/Dialog";
import { TextField } from "../shared/ui/TextField";
import { commandErrorMessage } from "../library/errorMessage";

type Preview = { targetId: string; name: string; seriesId: string; destinationId: string | null; assetCount: number; sharedCount: number; unavailableCount: number; token: string };
export function CharacterConversion({ targetId, onClose, onConverted }: { targetId: string; onClose: () => void; onConverted: (folderId: string) => void }) {
  const [preview, setPreview] = useState<Preview | null>(null);
  const [confirming, setConfirming] = useState(false), [confirmation, setConfirmation] = useState("");
  const [busy, setBusy] = useState(false), [error, setError] = useState<string | null>(null);
  const [reload, setReload] = useState(0);
  useEffect(() => {
    let active = true;
    setPreview(null); setConfirming(false); setConfirmation(""); setError(null);
    void invoke<Preview>("character_conversion_preview", { targetId }).then(value => { if (active) setPreview(value); }).catch(error => { if (active) setError(commandErrorMessage(error, "전환 대상을 확인하지 못했습니다.")); });
    return () => { active = false; };
  }, [targetId, reload]);
  async function convert() {
    if (!preview || busy) return;
    setBusy(true); setError(null);
    try { const folderId = await invoke<string>("convert_character_to_folder", { targetId, token: preview.token, confirmation }); onConverted(folderId); }
    catch (error) { setError(commandErrorMessage(error, "폴더로 전환하지 못했습니다. 대상을 다시 확인해 주세요.")); }
    finally { setBusy(false); }
  }
  return <Dialog open title="일반 폴더로 전환" onClose={() => { if (!busy) onClose(); }}>
    {preview ? <>
      <p><strong>{preview.name}</strong>의 확정 자산과 기준·추가 참조 {preview.assetCount}개를 같은 시리즈 아래 일반 폴더에 모읍니다.</p>
      <p>{preview.destinationId ? "같은 이름의 기존 폴더에 합칩니다. 그 폴더의 기존 자산과 하위 폴더는 유지합니다." : "같은 이름의 일반 폴더를 만듭니다."}</p>
      <p>원본은 복사하거나 삭제하지 않습니다. 다른 캐릭터와 공유하는 {preview.sharedCount}개의 연결은 유지하며 직접 분류만 이 폴더로 바뀝니다. 미확정 검토 후보는 포함하지 않습니다.</p>
      {preview.unavailableCount > 0 && <p>휴지통·누락 상태 {preview.unavailableCount}개는 복원하지 않습니다. 남아 있는 자산의 폴더 연결을 보존합니다.</p>}
      <p>이 캐릭터의 등록, 기준·추가 참조 설정과 판단 이력은 정리됩니다. 다른 캐릭터의 설정과 판단 이력은 유지합니다.</p>
      {confirming ? <><TextField label={`확인: ${preview.name} 입력`} value={confirmation} disabled={busy} onChange={event => setConfirmation(event.target.value)} /><Button disabled={busy || confirmation !== preview.name} onClick={() => void convert()}>확인한 내용으로 전환</Button></> : <Button onClick={() => setConfirming(true)}>내용 확인 · 계속</Button>}
    </> : !error && <p role="status">전환 대상 확인 중…</p>}
    {error && <p role="alert">{error}<Button disabled={busy} onClick={() => setReload(value => value + 1)}>대상 다시 확인</Button></p>}
    <Button variant="ghost" disabled={busy} onClick={onClose}>취소</Button>
  </Dialog>;
}
