import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Toast } from "../shared/ui/Toast";
import { useAutoDismiss } from "../shared/ui/useAutoDismiss";
import { Button } from "../shared/ui/Button";
import { Toggle } from "../shared/ui/Toggle";
import { TextField } from "../shared/ui/TextField";
import { useWorkloadProfile, updateWorkloadSettings, nativeWorkload } from "./workloadProfile";

export function WorkloadControls({ compact = false }: { compact?: boolean }) {
  const profile = useWorkloadProfile();
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  useAutoDismiss(notice, setNotice);
  const [minutes, setMinutes] = useState(String(profile.autoEnterMinutes ?? 10));
  useEffect(() => { setMinutes(String(profile.autoEnterMinutes ?? 10)); }, [profile.autoEnterMinutes]);
  if (!nativeWorkload()) return null;
  const toggle = async () => {
    setBusy(true);
    try { await updateWorkloadSettings({ lightweight: !profile.lightweight }); }
    finally { setBusy(false); }
  };
  const cancelScans = async () => {
    try {
      await invoke("workload_cancel_scans");
      window.dispatchEvent(new Event("lakomics:cancel-user-scans"));
      setNotice("진행 중인 검사가 안전한 지점에서 중단됩니다.");
    } catch { setNotice("검사 중단 요청을 보내지 못했습니다."); }
  };
  const label = profile.lightweight ? "가벼운 모드 켜짐" : profile.restricted ? "일반 모드 · 천천히 재개 중" : "가벼운 모드";
  if (compact) return <>
    <Button size="sm" variant="ghost" disabled={busy || !profile.ready} aria-pressed={profile.lightweight} onClick={() => void toggle()}>{label}</Button>
    {profile.lightweight && <Button size="sm" variant="ghost" onClick={() => void cancelScans()}>검사 중단 요청</Button>}
    {notice && <Toast onDismiss={() => setNotice(null)}>{notice}</Toast>}
  </>;
  return <section aria-label="가벼운 모드" className="settings-view__section">
    <header className="settings-view__header"><h2>가벼운 모드</h2></header>
    <dl className="settings-view__property">
      <dt>PC 작업 줄이기</dt>
      <dd>모바일 동기화를 유지하며 분석과 정리 작업을 줄입니다. 이 PC에만 적용됩니다.</dd>
      <Button disabled={busy || !profile.ready} aria-pressed={profile.lightweight} onClick={() => void toggle()}>{label}</Button>
    </dl>
    <dl className="settings-view__property">
      <dt>자동 전환</dt><dd>창이 숨겨지거나 포커스를 잃은 상태가 이어지면 켭니다.</dd>
      <Toggle aria-label="가벼운 모드 자동 전환" checked={profile.autoEnterMinutes !== null} disabled={!profile.ready || busy} onChange={event => void updateWorkloadSettings({ autoEnterMinutes: event.target.checked ? 10 : null })}>{profile.autoEnterMinutes === null ? "꺼짐" : "켜짐"}</Toggle>
    </dl>
    {profile.autoEnterMinutes !== null && <dl className="settings-view__property">
      <dt>자동 전환 대기</dt><dd>현재 {profile.autoEnterMinutes}분</dd>
      <dd className="settings-view__inline-controls">
        <TextField label="대기 시간 (분)" type="number" min={1} max={1440} value={minutes} onChange={event => setMinutes(event.target.value)} />
        <Button size="sm" disabled={!Number.isInteger(Number(minutes)) || Number(minutes) < 1 || Number(minutes) > 1440} onClick={() => void updateWorkloadSettings({ autoEnterMinutes: Number(minutes) })}>적용</Button>
      </dd>
    </dl>}
    <dl className="settings-view__property">
      <dt>닫기 동작</dt><dd>트레이에 숨기면 모바일 동기화가 계속됩니다. 종료는 트레이 메뉴에서 선택하세요.</dd>
      <Toggle checked={profile.closeToTray} disabled={!profile.ready || !profile.trayAvailable} onChange={event => void updateWorkloadSettings({ closeToTray: event.target.checked })}>닫기 버튼으로 트레이에 숨기기</Toggle>
    </dl>
    {profile.ready && !profile.trayAvailable && <p role="status">트레이를 사용할 수 없어 닫으면 앱이 종료됩니다.</p>}
    {profile.lightweight && <dl className="settings-view__property">
      <dt>진행 중인 검사</dt><dd>직접 시작한 검사는 계속됩니다. 필요한 경우 중단을 요청하세요.</dd>
      <Button size="sm" onClick={() => void cancelScans()}>진행 중인 검사 중단 요청</Button>
    </dl>}
    {profile.error && <p role="alert">{profile.error}</p>}
    {notice && <p role="status">{notice}</p>}
  </section>;
}
