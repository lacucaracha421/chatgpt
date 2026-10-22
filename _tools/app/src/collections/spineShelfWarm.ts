/**
 * Spine images that are already decoded. A spine whose image is known to be warm draws in its first frame
 * instead of fading in over its plastic, so a list change that prepared its first screen swaps in one step.
 */
const warm = new Set<string>();
const ratios = new Map<string, number>();
export const spineImageRatio = (url: string) => ratios.get(url);
const WARM_LIMIT = 4096;
export const isSpineWarm = (url: string | null) => Boolean(url) && warm.has(url!);
export function markSpineWarm(url: string) {
  warm.delete(url); warm.add(url);
  if (warm.size > WARM_LIMIT) warm.delete(warm.values().next().value!);
}
/** Test seam. */
export function resetSpineWarmForTests() { warm.clear(); ratios.clear(); queue.length = 0; queued.clear(); }

/** Resolves once `url` is decoded (or cannot be); an image the browser cannot decode never blocks the shelf. */
export async function decodeSpine(url: string): Promise<void> {
  if (warm.has(url) && ratios.has(url)) return;
  const image = new Image();
  image.src = url;
  if (typeof image.decode !== "function") return;
  try {
    await image.decode();
    if (image.naturalWidth && image.naturalHeight) {
      ratios.set(url, image.naturalWidth / image.naturalHeight);
      if (ratios.size > WARM_LIMIT) ratios.delete(ratios.keys().next().value!);
    }
    markSpineWarm(url);
  } catch { /* the spine's own element reports it */ }
}

/** Decodes spines a little ahead of the viewport, a few at a time, so scrolling rarely shows a plastic spine. */
const POOL = 4, QUEUE_LIMIT = 400;
const queue: string[] = [];
const queued = new Set<string>();
let active = 0;
function pump() {
  while (active < POOL && queue.length) {
    const url = queue.shift()!; queued.delete(url);
    active++;
    void decodeSpine(url).finally(() => { active--; pump(); });
  }
}
export function warmSpines(urls: string[]) {
  for (const url of urls) {
    if (warm.has(url) || queued.has(url)) continue;
    queue.push(url); queued.add(url);
    if (queue.length > QUEUE_LIMIT) queued.delete(queue.shift()!);
  }
  pump();
}
