import { WorkloadControls } from "../app/WorkloadControls";
import { nativeWorkload, useWorkloadProfile } from "../app/workloadProfile";

/** One compact row in Settings › 일반; the full lightweight-mode controls sit behind a disclosure. */
export function LightweightModeSettings() {
  const profile = useWorkloadProfile();
  if (!nativeWorkload()) return null;
  const parts = [
    profile.lightweight ? "지금 켜짐" : null,
    profile.autoEnterMinutes === null ? "자동 전환 꺼짐" : `${profile.autoEnterMinutes}분 뒤 자동 전환`,
    profile.closeToTray && profile.trayAvailable ? "닫으면 트레이로" : null,
  ].filter(Boolean);
  return <details className="settings-view__advanced settings-view__lightweight">
    <summary>가벼운 모드 · {profile.ready ? parts.join(" · ") : "확인 중…"}</summary>
    <WorkloadControls />
  </details>;
}
