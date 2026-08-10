import { getCurrentWindow } from "@tauri-apps/api/window";

export function WindowControls() {
  const window = getCurrentWindow();
  return (
    <div className="window-controls" aria-label="창 제어">
      <button type="button" className="window-controls__button" aria-label="창 최소화" onClick={() => void window.minimize()} />
      <button type="button" className="window-controls__button" aria-label="창 최대화" onClick={() => void window.toggleMaximize()} />
      <button type="button" className="window-controls__button window-controls__button--close" aria-label="창 닫기" onClick={() => void window.close()} />
    </div>
  );
}
