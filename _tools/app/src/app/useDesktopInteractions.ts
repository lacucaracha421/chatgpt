import { useEffect } from "react";

export function useDesktopInteractions(requestBack: () => boolean = () => false) {
  useEffect(() => {
    const blockContextMenu = (event: MouseEvent) => event.preventDefault();
    const blockMouseBack = (event: MouseEvent) => {
      if (event.button === 3) event.preventDefault();
    };
    const handleMouseBack = (event: MouseEvent) => {
      if (event.button !== 3) return;
      event.preventDefault();
      requestBack();
    };

    document.addEventListener("contextmenu", blockContextMenu);
    window.addEventListener("mousedown", blockMouseBack);
    window.addEventListener("auxclick", blockMouseBack);
    window.addEventListener("mouseup", handleMouseBack);
    return () => {
      document.removeEventListener("contextmenu", blockContextMenu);
      window.removeEventListener("mousedown", blockMouseBack);
      window.removeEventListener("auxclick", blockMouseBack);
      window.removeEventListener("mouseup", handleMouseBack);
    };
  }, [requestBack]);
}
