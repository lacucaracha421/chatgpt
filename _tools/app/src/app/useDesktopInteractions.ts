import { useEffect } from "react";

export function useDesktopInteractions(requestBack: () => boolean = () => false) {
  useEffect(() => {
    const blockContextMenu = (event: MouseEvent) => event.preventDefault();
    const blockMouseBack = (event: MouseEvent) => {
      if (event.button === 3) event.preventDefault();
    };
    // Surfaces that cancel pointerdown (the video element does, to keep focus) suppress the
    // compatibility mouseup, so the back button is also read from pointerup. Pointerup comes
    // first; the mouseup that normally follows is then ignored.
    let handledByPointer = false;
    const handlePointerBack = (event: PointerEvent) => {
      if (event.button !== 3) return;
      event.preventDefault();
      handledByPointer = true;
      window.setTimeout(() => { handledByPointer = false; }, 0);
      requestBack();
    };
    const handleMouseBack = (event: MouseEvent) => {
      if (event.button !== 3) return;
      event.preventDefault();
      if (handledByPointer) return;
      requestBack();
    };

    document.addEventListener("contextmenu", blockContextMenu);
    window.addEventListener("mousedown", blockMouseBack);
    window.addEventListener("auxclick", blockMouseBack);
    window.addEventListener("pointerup", handlePointerBack);
    window.addEventListener("mouseup", handleMouseBack);
    return () => {
      document.removeEventListener("contextmenu", blockContextMenu);
      window.removeEventListener("mousedown", blockMouseBack);
      window.removeEventListener("auxclick", blockMouseBack);
      window.removeEventListener("pointerup", handlePointerBack);
      window.removeEventListener("mouseup", handleMouseBack);
    };
  }, [requestBack]);
}
