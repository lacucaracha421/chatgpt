import { useDelayedBusy } from "../shared/useDelayedBusy";
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
  const showChecking = useDelayedBusy(!preview && !error);
  return <Dialog open title="일반 폴더로 전환" onClose={() => { if (!busy) onClose(); }}>
    {preview && !showChecking ? <>
      <p><strong>{preview.name}</strong> 확정 이미지·레퍼런스 {preview.assetCount}개를 같은 시리즈 아래 일반 폴더로 이동</p>
      <p>{preview.destinationId ? "같은 이름 폴더에 병합 · 기존 파일과 하위 폴더 유지" : "같은 이름의 일반 폴더 생성"}</p>
      <p>원본 복사·삭제 없음 · 다른 캐릭터 공유 {preview.sharedCount}개 연결 유지 · 확인 대기 후보 제외</p>
      {preview.unavailableCount > 0 && <p>휴지통·누락 {preview.unavailableCount}개 미복원 · 남은 파일 연결 유지</p>}
      <p>이 캐릭터의 등록·레퍼런스·판단 이력 정리 · 다른 캐릭터 설정 유지</p>
      {confirming ? <><TextField label={`확인: ${preview.name} 입력`} value={confirmation} disabled={busy} onChange={event => setConfirmation(event.target.value)} /><Button disabled={busy || confirmation !== preview.name} onClick={() => void convert()}>확인한 내용으로 전환</Button></> : <Button onClick={() => setConfirming(true)}>내용 확인 · 계속</Button>}
    </> : showChecking && !error && <p role="status">전환 대상 확인 중…</p>}
    {error && <p role="alert">{error}<Button disabled={busy} onClick={() => setReload(value => value + 1)}>다시 시도</Button></p>}
    <Button variant="ghost" disabled={busy} onClick={onClose}>취소</Button>
  </Dialog>;
}
