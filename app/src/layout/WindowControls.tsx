import { getCurrentWindow } from "@tauri-apps/api/window";

export function WindowControls() {
  const window = getCurrentWindow();
  return (
    <div className="window-controls" aria-label="창 제어">
      <button type="button" className="window-controls__button" aria-label="창 최소화" onClick={() => { try { void window.minimize(); } catch (error) { console.warn("창 최소화 실패", error); } }}>
        <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true"><path d="M1 6h10" stroke="currentColor" strokeWidth="1" /></svg>
      </button>
      <button type="button" className="window-controls__button" aria-label="창 최대화" onClick={() => { try { void window.toggleMaximize(); } catch (error) { console.warn("창 최대화 실패", error); } }}>
        <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true"><rect x="1.5" y="1.5" width="9" height="9" fill="none" stroke="currentColor" strokeWidth="1" /></svg>
      </button>
      <button type="button" className="window-controls__button window-controls__button--close" aria-label="창 닫기" onClick={() => { try { void window.close(); } catch (error) { console.warn("창 닫기 실패", error); } }}>
        <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true"><path d="M2 2l8 8M10 2l-8 8" stroke="currentColor" strokeWidth="1" /></svg>
      </button>
    </div>
  );
}
