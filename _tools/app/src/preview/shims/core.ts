import { dispatchPreviewCommand, PREVIEW_FIXTURE_MARKER } from "../fixtures";

declare global {
  interface Window {
    __TAURI_INTERNALS__?: Record<string, unknown>;
  }
}

window.__TAURI_INTERNALS__ = {};
document.documentElement.dataset.lakomicsPreview = PREVIEW_FIXTURE_MARKER;
localStorage.setItem("lakomics.libraryPath", "/preview/library");

const params = new URLSearchParams(window.location.search);
if (params.get("privacy") === "1") {
  const key = "lakomics.uiPreferences.v1";
  let current: Record<string, unknown> = {};
  try { current = JSON.parse(localStorage.getItem(key) ?? "{}"); } catch { /* reset malformed preview state */ }
  localStorage.setItem(key, JSON.stringify({ ...current, privacyMode: true }));
}
if (params.get("panel") === "info") {
  // A click only focuses (2026-09-29); the 정보 dock follows its saved open state, so open it here.
  localStorage.setItem("lakomics.assets.infoPanel.open.v1", "true");
  const openInfo = () => {
    const firstAsset = document.querySelector<HTMLElement>(".asset-gallery__asset[data-asset-id]");
    if (!firstAsset) return false;
    firstAsset.click();
    return true;
  };
  const observer = new MutationObserver(() => {
    if (openInfo()) observer.disconnect();
  });
  observer.observe(document.documentElement, { childList: true, subtree: true });
  window.setTimeout(() => observer.disconnect(), 10_000);
}

export function invoke<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  return Promise.resolve(dispatchPreviewCommand(command, args ?? {}) as T);
}

export function isTauri(): boolean { return true; }

export function convertFileSrc(path: string, protocol = "asset"): string {
  const root = `${window.location.origin}/preview-media`;
  if (protocol === "lakomics") return path ? `${root}/${encodeURIComponent(path)}` : root;
  return path ? `${root}/file/${encodeURIComponent(path)}` : `${root}/file`;
}

export class Channel<T = unknown> {
  onmessage: (message: T) => void = () => undefined;
}
