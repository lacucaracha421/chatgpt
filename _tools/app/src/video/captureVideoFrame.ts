/** Longest side of a captured frame; vault thumbnails are re-encoded at this size or smaller. */
const MAX_SIDE = 640;
const TIMEOUT_MS = 15_000;

/**
 * Captures the frame at `timeMs` of `url` as a JPEG, using a hidden player of its own so the visible
 * one keeps playing. Rejects when the frame cannot be read (no CORS access, decode failure, timeout),
 * so the caller can fall back to a server-side capture.
 */
export function captureVideoFrame(url: string, timeMs: number): Promise<Blob> {
  return new Promise((resolve, reject) => {
    const video = document.createElement("video");
    let timer = 0;
    const finish = (error: Error | null, blob?: Blob) => {
      window.clearTimeout(timer);
      video.removeAttribute("src");
      video.load();
      if (error) reject(error); else resolve(blob!);
    };
    timer = window.setTimeout(() => finish(new Error("frame capture timed out")), TIMEOUT_MS);
    video.crossOrigin = "anonymous";
    video.muted = true;
    video.preload = "auto";
    video.addEventListener("error", () => finish(new Error("frame capture failed")), { once: true });
    video.addEventListener("loadedmetadata", () => {
      video.currentTime = Math.min(timeMs / 1_000, Math.max(0, video.duration - 0.05) || 0);
    }, { once: true });
    video.addEventListener("seeked", () => {
      try {
        const scale = Math.min(1, MAX_SIDE / Math.max(video.videoWidth, video.videoHeight));
        const canvas = document.createElement("canvas");
        canvas.width = Math.max(1, Math.round(video.videoWidth * scale));
        canvas.height = Math.max(1, Math.round(video.videoHeight * scale));
        const context = canvas.getContext("2d");
        if (!context || !video.videoWidth) throw new Error("no frame");
        context.drawImage(video, 0, 0, canvas.width, canvas.height);
        // Throws a SecurityError when the source did not grant CORS access.
        canvas.toBlob((blob) => blob ? finish(null, blob) : finish(new Error("frame capture failed")), "image/jpeg", 0.9);
      } catch (error) {
        finish(error instanceof Error ? error : new Error("frame capture failed"));
      }
    }, { once: true });
    video.src = url;
  });
}
