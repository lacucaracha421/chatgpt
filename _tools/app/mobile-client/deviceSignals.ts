/**
 * Native connectivity and power changes, sent only while the app is in the foreground
 * (Android `DeviceSignals`, PERF-ALL-001 §8). Work that waits for a charger or a network
 * listens here instead of re-checking on a short timer; each caller keeps a long safety timer
 * because an older app build, or a browser preview, never sends these events.
 */
export const NETWORK_EVENT = 'lakomics-network', POWER_EVENT = 'lakomics-power';
export type NetworkChange = {online:boolean; restored:boolean};

/** Charger connected/disconnected or battery okay/low. Returns the unsubscribe function. */
export function onPowerChange(listener:()=>void) {
  window.addEventListener(POWER_EVENT, listener);
  return () => window.removeEventListener(POWER_EVENT, listener);
}

/** A validated network appeared (a reconnect or a switch). Returns the unsubscribe function. */
export function onNetworkRestored(listener:()=>void) {
  const handler = (event:Event) => { const detail = (event as CustomEvent<NetworkChange|null>).detail; if (detail?.online && detail.restored) listener(); };
  window.addEventListener(NETWORK_EVENT, handler);
  return () => window.removeEventListener(NETWORK_EVENT, handler);
}
