import { useEffect } from "react";

export function useDesktopInteractions() {
  useEffect(() => {
    const blockContextMenu = (event: MouseEvent) => event.preventDefault();
    const blockMouseBack = (event: MouseEvent) => {
      if (event.button === 3) event.preventDefault();
    };
    const requestBack = (event: MouseEvent) => {
      if (event.button !== 3) return;
      event.preventDefault();
      (document.activeElement ?? window).dispatchEvent(new KeyboardEvent("keydown", {
        key: "Escape",
        code: "Escape",
        bubbles: true,
        cancelable: true,
      }));
    };

    document.addEventListener("contextmenu", blockContextMenu);
    window.addEventListener("mousedown", blockMouseBack);
    window.addEventListener("auxclick", blockMouseBack);
    window.addEventListener("mouseup", requestBack);
    return () => {
      document.removeEventListener("contextmenu", blockContextMenu);
      window.removeEventListener("mousedown", blockMouseBack);
      window.removeEventListener("auxclick", blockMouseBack);
      window.removeEventListener("mouseup", requestBack);
    };
  }, []);
}
