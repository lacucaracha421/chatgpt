import { pcHomeReady, pcStartupMark, pcStartupEvent, pcPerfEnabled } from "../pcPerfLog";
import { invoke } from "@tauri-apps/api/core";
import { useEffect, useLayoutEffect, useState, useSyncExternalStore, type CSSProperties, type RefObject } from "react";
import { reducedMotion } from "../motion/curves";
import { viewportImages, waitForViewportImages } from "../motion/viewportImages";
import "./launchSplash.css";

/** Fail-safe: whatever is ready is revealed this long after the page started. */
export const LAUNCH_CAP_MS = 8000;
/** A start slower than this shows the loading line under the mark. */
export const LAUNCH_HINT_MS = 3000;
/** First-screen images get this long once the screen's data is ready. */
export const LAUNCH_IMAGE_CAP_MS = 1500;
/** Quiet window for images whose address arrives just after the data (tablet covers). */
const LAUNCH_SETTLE_MS = 120;
/** Matches `--motion-screen` in launchSplash.css. */
const LAUNCH_FADE_MS = 240;
/** Maintenance still runs if the readiness owner or cover never reports completion. */
export const LAUNCH_MAINTENANCE_FALLBACK_MS = LAUNCH_CAP_MS + LAUNCH_IMAGE_CAP_MS + LAUNCH_FADE_MS;
/** The static cover in both index.html files, painted before any script runs. */
export const LAUNCH_COVER_ID = "launch-cover";

type Phase = "waiting" | "leaving" | "done";
let phase: Phase = "waiting";
let present = false;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((listener) => listener());
const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
const currentPhase = () => phase;
const pageClock = () => performance.now();

/** Ends the launch splash; once per app start, later calls do nothing. */
export function releaseLaunchSplash() {
  if (phase !== "waiting") return;
  pcStartupMark("splashLeaving");
  phase = "leaving";
  emit();
}

/** True while a mounted splash still covers the app. */
export function launchSplashWaiting() {
  return present && phase === "waiting";
}

/** Includes the fade; status consumers must not wake maintenance while it still covers Home. */
export function launchSplashPresent() {
  return present && phase !== "done";
}

/** Schedule background maintenance after the cover has left and a short idle window. */
export function afterLaunchSettled(task: () => void) {
  let timer: number | undefined;
  let started = false;
  const run = () => {
    if (started) return;
    started = true;
    task();
  };
  const fallback = window.setTimeout(run, LAUNCH_MAINTENANCE_FALLBACK_MS);
  const check = () => {
    if (present && phase !== 'done') return;
    if (timer === undefined) timer = window.setTimeout(run, 300);
  };
  const stop = subscribe(check);
  check();
  return () => { stop(); window.clearTimeout(timer); window.clearTimeout(fallback); };
}

export function resetLaunchSplashForTests() {
  phase = "waiting";
  present = false;
  emit();
}

/**
 * The first screen of the app tells the splash it is ready. With a host, the splash also waits for
 * the host's on-screen images (bounded by {@link LAUNCH_IMAGE_CAP_MS}). Does nothing once the
 * splash has gone, so later visits to the same screen never bring it back.
 */
export function useLaunchReady(ready: boolean, host?: RefObject<HTMLElement | null>) {
  useEffect(() => {
    if (ready && host?.current) pcHomeReady(host.current);
    if (!ready || !launchSplashWaiting()) return;
    const element = host?.current;
    if (!element) { releaseLaunchSplash(); return; }
    return whenImagesSettle(element, releaseLaunchSplash);
  }, [ready, host]);
}

function whenImagesSettle(host: HTMLElement, done: () => void) {
  const deadline = Date.now() + LAUNCH_IMAGE_CAP_MS;
  let stop = () => undefined as void;
  let timer = 0;
  const load = (event: Event) => {
    if (event.target instanceof HTMLImageElement && viewportImages(host).includes(event.target)) {
      pcStartupEvent("home.images.load");
    }
  };
  if (pcPerfEnabled()) host.addEventListener("load", load, true);
  const round = () => {
    pcStartupEvent("home.images.wait");
    let capped = false;
    stop = waitForViewportImages(host, () => {
      pcStartupEvent("home.images.settled", { capped });
      timer = window.setTimeout(() => {
        const late = viewportImages(host).some((image) => !image.complete);
        if (late && Date.now() < deadline) round();
        else { host.removeEventListener("load", load, true); done(); }
      }, LAUNCH_SETTLE_MS);
    }, Math.max(0, deadline - Date.now()), late => {
      capped = true;
      pcStartupEvent("home.images.cap", { pendingCount: late.length });
    });
  };
  round();
  return () => { stop(); window.clearTimeout(timer); host.removeEventListener("load", load, true); };
}

/** The Lakomics mark (src/brand/lakomics-mark.svg), cropped to its outline. */
export function LakomicsMark({ className }: { className?: string }) {
  return <svg className={className} viewBox="40 32 176 192" fill="currentColor" aria-hidden="true" focusable="false">
    <path fillRule="evenodd" d="M40 56H80V200H40ZM48 64V192H72V64ZM108 32H148V224H108ZM116 40V216H140V40ZM176 56H216V200H176ZM184 64V192H208V64Z" />
  </svg>;
}

type LaunchSplashProps = {
  /** Test seam; milliseconds since the page started (the static cover's first paint). */
  elapsed?: () => number;
  capMs?: number;
};

/**
 * Shared launch splash (PC and tablet). It takes over the static cover from index.html in the same
 * frame, stays until the first screen calls {@link useLaunchReady} or the cap passes, then fades
 * out once (reduced motion: at once). Rendered beside the App root, outside every area.
 */
export function LaunchSplash({ elapsed = pageClock, capMs = LAUNCH_CAP_MS }: LaunchSplashProps) {
  const current = useSyncExternalStore(subscribe, currentPhase, currentPhase);
  // Continue the static cover's hint timing instead of restarting it at mount.
  const [hintDelay] = useState(() => Math.round(LAUNCH_HINT_MS - elapsed()));
  useLayoutEffect(() => {
    pcStartupMark("firstReactRender");
    present = true;
    document.getElementById(LAUNCH_COVER_ID)?.remove();
    const timer = window.setTimeout(releaseLaunchSplash, Math.max(0, capMs - elapsed()));
    return () => { window.clearTimeout(timer); present = false; };
  }, [capMs, elapsed]);
  useEffect(() => {
    if (current === "done") {
      pcStartupMark("splashEnd");
      if ("__TAURI_INTERNALS__" in window) {
        return afterLaunchSettled(() => { void invoke("workload_launch_settled").catch(() => undefined); });
      }
      return;
    }
    if (current !== "leaving") return;
    const timer = window.setTimeout(() => {
      phase = "done";
      emit();
    }, reducedMotion() ? 0 : LAUNCH_FADE_MS);
    return () => window.clearTimeout(timer);
  }, [current]);
  if (current === "done") return null;
  return <div className="launch-splash" data-state={current === "leaving" ? "leaving" : undefined} data-tauri-drag-region role="status" aria-label="Lakomics 여는 중"
    style={{ "--launch-hint-delay": `${hintDelay}ms` } as CSSProperties}>
    <LakomicsMark className="launch-splash__mark" />
    <span className="launch-splash__hint" aria-hidden="true" />
  </div>;
}
