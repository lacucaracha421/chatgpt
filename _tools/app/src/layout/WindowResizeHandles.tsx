import { useEffect, useState } from "react";
import { isTauri } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import "./windowResizeHandles.css";

const directions = ["North", "South", "East", "West", "NorthEast", "NorthWest", "SouthEast", "SouthWest"] as const;

/** Undecorated windows need explicit resize hit targets, including on Linux. */
export function WindowResizeHandles() {
  const [enabled, setEnabled] = useState(false);
  useEffect(() => {
    if (!isTauri()) return;
    const window = getCurrentWindow();
    let active = true;
    let revision = 0;
    const refresh = async () => {
      const request = ++revision;
      try {
        const [maximized, fullscreen, resizable] = await Promise.all([
          window.isMaximized(), window.isFullscreen(), window.isResizable(),
        ]);
        if (active && request === revision) setEnabled(resizable && !maximized && !fullscreen);
      } catch { if (active && request === revision) setEnabled(false); }
    };
    const listener = window.onResized(() => void refresh());
    void refresh();
    void listener.catch(() => { if (active) setEnabled(false); });
    return () => { active = false; void listener.then(unlisten => unlisten()).catch(() => {}); };
  }, []);

  if (!enabled) return null;
  return <div className="window-resize" aria-hidden="true">
    {directions.map(direction => <div
      key={direction}
      className={`window-resize__handle window-resize__handle--${direction}`}
      onMouseDown={event => {
        if (event.button !== 0) return;
        event.preventDefault();
        event.stopPropagation();
        void getCurrentWindow().startResizeDragging(direction).catch(error => console.warn("창 크기 조절 실패", error));
      }}
    />)}
  </div>;
}
