import { useEffect, useState } from "react";
import { Switch } from "../shared/ui/Switch";
import { TextInput } from "../shared/ui/TextInput";
import { useWorkloadProfile, updateWorkloadSettings, nativeWorkload } from "./workloadProfile";

/** The instant lightweight-mode switch shown in the status panel. */
export function LightweightModeToggle() {
  const profile = useWorkloadProfile();
  const [busy, setBusy] = useState(false);
  if (!nativeWorkload()) return null;
  const toggle = async () => {
    setBusy(true);
    try { await updateWorkloadSettings({ lightweight: !profile.lightweight }); }
    finally { setBusy(false); }
  };
  return <div className="lightweight-toggle">
    <div className="chrome-settings-controls">
      <Switch checked={profile.lightweight} disabled={busy || !profile.ready} onChange={() => void toggle()} aria-label="가벼운 모드" />
    </div>
    {profile.restricted && <small className="chrome-settings-note">일반 모드 · 천천히 재개 중</small>}
    {profile.error && <p role="alert" className="chrome-settings-note">{profile.error}</p>}
  </div>;
}

/** Settings rows for lightweight mode. The surrounding screen owns the group label. */
export function WorkloadControls() {
  const profile = useWorkloadProfile();
  const [busy, setBusy] = useState(false);
  const [minutes, setMinutes] = useState(String(profile.autoEnterMinutes ?? 10));
  useEffect(() => { setMinutes(String(profile.autoEnterMinutes ?? 10)); }, [profile.autoEnterMinutes]);
  if (!nativeWorkload()) return null;
  const toggle = async () => {
    setBusy(true);
    try { await updateWorkloadSettings({ lightweight: !profile.lightweight }); }
    finally { setBusy(false); }
  };
  const applyMinutes = () => {
    const value = Number(minutes);
    if (!Number.isInteger(value) || value < 1 || value > 1440 || busy) return;
    void updateWorkloadSettings({ autoEnterMinutes: value });
  };
  const status = profile.lightweight ? "켜짐" : profile.restricted ? "천천히 재개 중" : "꺼짐";
  return <>
    <dl className="settings-view__property">
      <dt>PC 작업 줄이기</dt>
      <dd className="settings-view__status">{status}</dd>
      <dd className="settings-view__inline-controls"><Switch aria-label="PC 작업 줄이기" checked={profile.lightweight} disabled={busy || !profile.ready} onChange={() => void toggle()} /></dd>
    </dl>
    <dl className="settings-view__property">
      <dt>자동 전환</dt>
      <dd className="settings-view__inline-controls"><Switch aria-label="가벼운 모드 자동 전환" checked={profile.autoEnterMinutes !== null} disabled={!profile.ready || busy} onChange={event => void updateWorkloadSettings({ autoEnterMinutes: event.target.checked ? 10 : null })} /></dd>
    </dl>
    <dl className="settings-view__property">
      <dt>자동 전환 대기</dt>
      <dd className="settings-view__status">{profile.autoEnterMinutes === null ? "자동 전환 꺼짐" : `${profile.autoEnterMinutes}분`}</dd>
      <dd className="settings-view__inline-controls">
        <TextInput aria-label="자동 전환 대기 (분)" type="number" min={1} max={1440} value={minutes} disabled={!profile.ready || profile.autoEnterMinutes === null} onChange={event => setMinutes(event.target.value)} onBlur={applyMinutes} onKeyDown={event => { if (event.key === "Enter") applyMinutes(); }} />
      </dd>
    </dl>
    <dl className="settings-view__property">
      <dt>닫기 버튼으로 트레이에 숨기기</dt>
      <dd className="settings-view__inline-controls"><Switch aria-label="닫기 버튼으로 트레이에 숨기기" checked={profile.closeToTray} disabled={!profile.ready || !profile.trayAvailable} onChange={event => void updateWorkloadSettings({ closeToTray: event.target.checked })} /></dd>
      {profile.ready && !profile.trayAvailable && <dd className="settings-view__status">트레이 사용 불가</dd>}
    </dl>
    {profile.error && <p className="settings-view__row-message" role="alert">{profile.error}</p>}
  </>;
}
