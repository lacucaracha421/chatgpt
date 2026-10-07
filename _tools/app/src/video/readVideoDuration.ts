const TIMEOUT_MS = 15_000;

/** Reads a video's length from its metadata with a hidden player of its own; rejects when unknown. */
export function readVideoDuration(url: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const video = document.createElement("video");
    let timer = 0;
    const finish = (durationMs: number | null) => {
      window.clearTimeout(timer);
      video.removeAttribute("src");
      video.load();
      if (durationMs) resolve(durationMs); else reject(new Error("video length unavailable"));
    };
    timer = window.setTimeout(() => finish(null), TIMEOUT_MS);
    video.muted = true;
    video.preload = "metadata";
    video.addEventListener("error", () => finish(null), { once: true });
    const known = () => Number.isFinite(video.duration) && video.duration > 0;
    video.addEventListener("loadedmetadata", () => {
      if (known()) return finish(Math.round(video.duration * 1_000));
      // Recordings without a length in their header: seeking past the end makes the engine
      // find the real end and report it through `durationchange`.
      video.addEventListener("durationchange", () => { if (known()) finish(Math.round(video.duration * 1_000)); });
      video.currentTime = Number.MAX_SAFE_INTEGER;
    }, { once: true });
    video.src = url;
  });
}
