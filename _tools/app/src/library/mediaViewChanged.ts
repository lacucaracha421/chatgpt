import { invoke } from "@tauri-apps/api/core";
import { useLayoutEffect, useRef } from "react";

/** Navigation must never wait for the native media queue or call it in previews. */
export function notifyMediaViewChanged() {
  if (typeof window === "undefined" || !("__TAURI_INTERNALS__" in window)) return;
  void invoke("media_view_changed").catch(() => undefined);
}

export function useMediaViewChanged(scope: string | undefined, visible = true) {
  const previous = useRef(scope);
  useLayoutEffect(() => {
    const changed = previous.current !== scope;
    previous.current = scope;
    if (visible && changed) notifyMediaViewChanged();
  }, [scope, visible]);
}
