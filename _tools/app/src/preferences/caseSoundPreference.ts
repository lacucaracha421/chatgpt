import { useCallback, useSyncExternalStore } from "react";

/**
 * "케이스 소리" — whether the Collections case and book play their recorded open/close sounds (on by default).
 * A device preference shared by the PC and the tablet build. It has its own key rather than a field of
 * `lakomics.uiPreferences.v1`, because App owns that object in memory and rewrites it whole on every change.
 */
export const CASE_SOUNDS_KEY = "lakomics.caseSounds";
const CHANGE_EVENT = "lakomics-case-sounds";

export function caseSoundsEnabled(): boolean {
  try { return localStorage.getItem(CASE_SOUNDS_KEY) !== "0"; } catch { return true; }
}

export function setCaseSoundsEnabled(enabled: boolean): void {
  try { localStorage.setItem(CASE_SOUNDS_KEY, enabled ? "1" : "0"); } catch { /* An optional device preference. */ }
  window.dispatchEvent(new Event(CHANGE_EVENT));
}

function subscribe(onChange: () => void) {
  window.addEventListener(CHANGE_EVENT, onChange);
  window.addEventListener("storage", onChange);
  return () => { window.removeEventListener(CHANGE_EVENT, onChange); window.removeEventListener("storage", onChange); };
}

/** The Settings switch for both builds. */
export function useCaseSounds(): [boolean, (enabled: boolean) => void] {
  const enabled = useSyncExternalStore(subscribe, caseSoundsEnabled, () => true);
  return [enabled, useCallback((value: boolean) => setCaseSoundsEnabled(value), [])];
}
