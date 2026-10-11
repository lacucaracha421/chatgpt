/** Keep the covering still until a frame for this position reaches the compositor. */
export function waitForVideoFrame(video: HTMLVideoElement, target: number, ready: () => void): () => void {
  let active = true;
  let frame: number | null = null;
  let paint: number | null = null;
  let presentedTime: number | null = null;
  // A stored length can run past the real end, where the element clamps the seek.
  const goal = () => Number.isFinite(video.duration) && video.duration > 0 ? Math.min(target, video.duration) : target;
  const usable = () => !video.seeking && video.readyState >= 2 && video.videoWidth > 0
    && video.currentTime >= goal() - 0.1;
  const finish = () => {
    if (!active) return;
    active = false;
    video.removeEventListener("seeked", checkPresented);
    if (frame !== null) video.cancelVideoFrameCallback?.(frame);
    ready();
  };
  const matches = (time: number) => Math.abs(time - video.currentTime) < 0.25 && time >= goal() - 0.1;
  const checkPresented = () => {
    if (presentedTime !== null && usable() && matches(presentedTime)) finish();
  };
  if (typeof video.requestVideoFrameCallback === "function") {
    // A paused seek may present its only frame before the seeked event is dispatched.
    video.addEventListener("seeked", checkPresented);
    const next = () => {
      frame = video.requestVideoFrameCallback((_now, metadata) => {
        if (!active) return;
        frame = null;
        presentedTime = metadata.mediaTime;
        // A queued callback can still describe the pre-seek frame, including on backwards seeks.
        if (usable() && matches(metadata.mediaTime)) finish();
        else next();
      });
    };
    next();
  } else {
    // WebKitGTK without rVFC: require decoded data at the requested position, then allow a paint
    // between two animation frames. A media event or a wall-clock timeout alone is not readiness.
    const next = () => {
      paint = window.requestAnimationFrame(() => {
        if (!active) return;
        if (!usable()) { next(); return; }
        const time = video.currentTime;
        paint = window.requestAnimationFrame(() => {
          if (!active) return;
          if (usable() && Math.abs(video.currentTime - time) < 0.25) finish();
          else next();
        });
      });
    };
    next();
  }
  return () => {
    active = false;
    video.removeEventListener("seeked", checkPresented);
    if (frame !== null) video.cancelVideoFrameCallback?.(frame);
    if (paint !== null) window.cancelAnimationFrame(paint);
  };
}
