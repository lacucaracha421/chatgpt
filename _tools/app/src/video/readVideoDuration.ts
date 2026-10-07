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
    video.addEventListener("loadedmetadata", () => {
      const seconds = video.duration;
      finish(Number.isFinite(seconds) && seconds > 0 ? Math.round(seconds * 1_000) : null);
    }, { once: true });
    video.src = url;
  });
}
