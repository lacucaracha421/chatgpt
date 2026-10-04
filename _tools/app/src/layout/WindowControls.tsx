import { getCurrentWindow } from "@tauri-apps/api/window";
import { ArrowPathIcon, PauseCircleIcon } from "@heroicons/react/24/outline";
import { updateWorkloadSettings, useWorkloadProfile } from "../app/workloadProfile";

/** Title-bar mark while the PC runs slow: a button that turns 절약 모드 off, then a quiet
 * "해제 중" label for the short recovery window before normal work resumes. */
export function LightweightModeIndicator() {
  const { lightweight, restricted, ready } = useWorkloadProfile();
  if (!ready || !restricted) return null;
  if (!lightweight) return <span className="lightweight-mode-indicator is-recovering" role="status">
    <ArrowPathIcon className="lightweight-mode-indicator__spin" aria-hidden="true" />
    <span>절약 모드 해제 중</span>
  </span>;
  return <button type="button" className="lightweight-mode-indicator" aria-label="절약 모드 끄기"
    onClick={() => { void updateWorkloadSettings({ lightweight: false }); }}>
    <PauseCircleIcon aria-hidden="true" />
    <span>절약 모드</span>
  </button>;
}

export function WindowControls() {
  const window = getCurrentWindow();
  return (
    <div className="window-controls" aria-label="창 제어">
      <button type="button" className="window-controls__button" aria-label="창 최소화" aria-description="최소화" onClick={() => { try { void window.minimize(); } catch (error) { console.warn("창 최소화 실패", error); } }}>
        <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true"><path d="M1 6h10" stroke="currentColor" strokeWidth="1" /></svg>
      </button>
      <button type="button" className="window-controls__button" aria-label="창 최대화" aria-description="최대화 / 복원" onClick={() => { try { void window.toggleMaximize(); } catch (error) { console.warn("창 최대화 실패", error); } }}>
        <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true"><rect x="1.5" y="1.5" width="9" height="9" fill="none" stroke="currentColor" strokeWidth="1" /></svg>
      </button>
      <button type="button" className="window-controls__button window-controls__button--close" aria-label="창 닫기" aria-description="닫기" onClick={() => { try { void window.close(); } catch (error) { console.warn("창 닫기 실패", error); } }}>
        <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true"><path d="M2 2l8 8M10 2l-8 8" stroke="currentColor" strokeWidth="1" /></svg>
      </button>
    </div>
  );
}
