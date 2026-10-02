import { useEffect, useState } from 'react';
export const INFO_PANEL_KEY = 'lakomics.assets.infoPanel.open.v1';
/** UI preference belongs to this device, not the library or its replicated settings. */
export function useInfoPanelPreference() {
  const [open, setOpen] = useState(() => { try { return localStorage.getItem(INFO_PANEL_KEY) === 'true'; } catch { return false; } });
  useEffect(() => { try { localStorage.setItem(INFO_PANEL_KEY, String(open)); } catch { /* Storage can be unavailable. */ } }, [open]);
  return [open, setOpen] as const;
}
