import { listen } from "@tauri-apps/api/event";

/**
 * In the desktop app one native pass owns every shared-authority domain (one
 * conditional status read, feeds only when a cursor moved, idle backoff). The React
 * hooks only relay its change events to the window events the UI already listens to.
 */
export function relayNativeAuthorityEvent(nativeEvent: string, windowEvent: string): () => void {
  let stopped = false;
  let unlisten: (() => void) | undefined;
  void listen(nativeEvent, () => window.dispatchEvent(new Event(windowEvent)))
    .then(stop => { if (stopped) stop(); else unlisten = stop; })
    .catch(() => undefined);
  return () => { stopped = true; unlisten?.(); };
}
