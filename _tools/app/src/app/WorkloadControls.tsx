import { useEffect, useState } from "react";
import { ArrowPathIcon } from "@heroicons/react/24/outline";
import { Select } from "../shared/ui/Select";
import { usePerformanceProfile, updatePerformanceProfile, type MachinePerformance } from "./performanceProfile";
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
  const recovering = profile.ready && !profile.lightweight && profile.restricted;
  const mode = !profile.ready ? "확인 중…" : profile.lightweight ? "절약 모드" : recovering ? "절약 모드 해제 중" : "일반 모드";
  return <div className="lightweight-toggle">
    <div className="chrome-settings-controls">
      <span className="lightweight-toggle__label">{recovering && <ArrowPathIcon className="lightweight-mode-indicator__spin" aria-hidden="true" />}{mode}</span>
      <Switch checked={profile.lightweight} disabled={busy || !profile.ready} onChange={() => void toggle()} aria-label="절약 모드" />
    </div>
    {recovering && <small className="chrome-settings-note">3분 안에 평소 속도로 돌아갑니다</small>}
    {profile.error && <p role="alert" className="chrome-settings-note">{profile.error}</p>}
  </div>;
}

/** Settings rows for lightweight mode. The surrounding screen owns the group label. */
export function WorkloadControls() {
  const performance = usePerformanceProfile();
  const [savingPerformance, setSavingPerformance] = useState(false);
  const profile = useWorkloadProfile();
  const [busy, setBusy] = useState(false);
  const [minutes, setMinutes] = useState(String(profile.autoEnterMinutes ?? 30));
  useEffect(() => { setMinutes(String(profile.autoEnterMinutes ?? 30)); }, [profile.autoEnterMinutes]);
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
  const status = !profile.ready ? "확인 중…" : profile.lightweight ? "절약 모드" : profile.restricted ? "절약 모드 해제 중" : "일반 모드";
  const selectPerformance = async (value: MachinePerformance) => {
    setSavingPerformance(true);
    try { await updatePerformanceProfile(value); }
    finally { setSavingPerformance(false); }
  };
  return <>
    <dl className="settings-view__property">
      <dt>이 컴퓨터의 성능</dt>
      <dd className="settings-view__inline-controls">
        <Select label="이 컴퓨터의 성능" value={performance.selected} disabled={!performance.ready || savingPerformance}
          onChange={event => void selectPerformance(event.target.value as MachinePerformance)}>
          <option value="laptop">노트북</option>
          <option value="main">메인 PC</option>
        </Select>
      </dd>
    </dl>
    <p className="settings-view__row-message">메인 PC는 CPU와 메모리를 더 사용합니다. 재시작 후 적용되며 절약 모드가 우선합니다.</p>
    {performance.ready && performance.selected !== performance.active && <p className="settings-view__row-message" role="status">재시작 후 적용 · 현재 {performance.active === "main" ? "메인 PC" : "노트북"}</p>}
    {performance.error && <p className="settings-view__row-message" role="alert">{performance.error}</p>}
    <dl className="settings-view__property">
      <dt>절약 모드</dt>
      <dd className="settings-view__status">{status}</dd>
      <dd className="settings-view__inline-controls"><Switch aria-label="절약 모드" checked={profile.lightweight} disabled={busy || !profile.ready} onChange={() => void toggle()} /></dd>
    </dl>
    <dl className="settings-view__property">
      <dt>자동 전환</dt>
      <dd className="settings-view__inline-controls"><Switch aria-label="절약 모드 자동 전환" checked={profile.autoEnterMinutes !== null} disabled={!profile.ready || busy} onChange={event => void updateWorkloadSettings({ autoEnterMinutes: event.target.checked ? 30 : null })} /></dd>
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
