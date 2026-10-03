import {useCallback, useSyncExternalStore} from 'react';

export const PRIVACY_MODE_KEY = 'lakomics.mobile.privacyMode';
export const PRIVACY_MODE_EVENT = 'lakomics-privacy-mode';

function readPrivacyMode(): boolean {
  try { return localStorage.getItem(PRIVACY_MODE_KEY) === '1'; } catch { return false; }
}

function writePrivacyMode(value: boolean): void {
  try { localStorage.setItem(PRIVACY_MODE_KEY, value ? '1' : '0'); } catch { /* optional device preference */ }
  window.dispatchEvent(new CustomEvent(PRIVACY_MODE_EVENT));
}

function subscribe(onChange: () => void) {
  window.addEventListener(PRIVACY_MODE_EVENT, onChange);
  window.addEventListener('storage', onChange);
  return () => { window.removeEventListener(PRIVACY_MODE_EVENT, onChange); window.removeEventListener('storage', onChange); };
}

/** Device-only privacy preference shared by Home, Settings and later private tabs. */
export function usePrivacyMode(): [boolean, (value: boolean) => void] {
  const enabled = useSyncExternalStore(subscribe, readPrivacyMode, () => false);
  const setEnabled = useCallback((value: boolean) => writePrivacyMode(value), []);
  return [enabled, setEnabled];
}

export function privacyMode(): boolean { return readPrivacyMode(); }

export const NSFW_FILTER_KEY = 'lakomics.mobile.nsfwFilter';
function readNsfwFilter(): boolean {
  try { return localStorage.getItem(NSFW_FILTER_KEY) === '1'; } catch { return false; }
}
export function useNsfwFilter(): [boolean, (value: boolean) => void] {
  const enabled = useSyncExternalStore(subscribe, readNsfwFilter, () => false);
  const setEnabled = useCallback((value: boolean) => {
    try {localStorage.setItem(NSFW_FILTER_KEY,value?'1':'0');} catch { /* optional device preference */ }
    window.dispatchEvent(new CustomEvent(PRIVACY_MODE_EVENT));
  },[]);
  return [enabled,setEnabled];
}
export function nsfwFilter(): boolean {return readNsfwFilter();}
