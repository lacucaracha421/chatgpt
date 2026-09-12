const IMAGE_TIMEOUT_MS = 12_000;
/** Anonymous CORS is required for both WebGL textures and canvas snapshots. */
export function loadCoverImage(src: string, signal?: AbortSignal): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(new DOMException("Cancelled", "AbortError")); return; }
    const image = new Image();
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return; settled = true;
      clearTimeout(timer); signal?.removeEventListener("abort", abort);
      image.onload = image.onerror = null;
      if (error) { image.src = ""; reject(error); } else resolve(image);
    };
    const abort = () => finish(new DOMException("Cancelled", "AbortError"));
    const timer = setTimeout(() => finish(new Error("Cover image timeout")), IMAGE_TIMEOUT_MS);
    image.crossOrigin = "anonymous";
    image.decoding = "async";
    image.onload = () => image.naturalWidth && image.naturalHeight
      ? finish() : finish(new Error("Empty cover image"));
    image.onerror = () => finish(new Error("Cover image unavailable"));
    signal?.addEventListener("abort", abort, { once: true });
    image.src = src;
    if (image.complete && image.naturalWidth) finish();
  });
}
