import { getCurrentWindow } from "@tauri-apps/api/window";

export function WindowControls() {
  const window = getCurrentWindow();
  return (
    <div className="window-controls" aria-label="창 제어">
      <button type="button" className="window-controls__button" aria-label="창 최소화" onClick={() => { try { void window.minimize(); } catch (error) { console.warn("창 최소화 실패", error); } }} />
      <button type="button" className="window-controls__button" aria-label="창 최대화" onClick={() => { try { void window.toggleMaximize(); } catch (error) { console.warn("창 최대화 실패", error); } }} />
      <button type="button" className="window-controls__button window-controls__button--close" aria-label="창 닫기" onClick={() => { try { void window.close(); } catch (error) { console.warn("창 닫기 실패", error); } }} />
    </div>
  );
}
