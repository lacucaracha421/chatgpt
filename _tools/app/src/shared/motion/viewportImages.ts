export const IMAGE_READY_CAP_MS = 250;

const decodedImages = new WeakMap<HTMLImageElement, string>();
/** Readiness decoding may finish before the image's own load handler runs. */
export const viewportImageDecoded = (image: HTMLImageElement) => decodedImages.get(image) === `${image.src}|${image.srcset}`;

/** Preparation is deliberately invisible; geometry, not visibility/IO, owns this batch. */
export function viewportImages(host: HTMLElement) {
  const viewport = host.getBoundingClientRect();
  return Array.from(host.querySelectorAll('img')).filter(image => {
    if (!image.getAttribute('src') || image.closest('.asset-gallery__folder-snapshot')) return false;
    if (image.dataset.stableImageLoading && !image.dataset.stableImagePending) return false;
    const rect = image.getBoundingClientRect();
    const scroller = image.closest('.asset-gallery__scroll, .gallery-scroll');
    const clip = scroller?.getBoundingClientRect() ?? viewport;
    return rect.width > 0 && rect.height > 0 && rect.bottom > Math.max(0, viewport.top, clip.top)
      && rect.top < Math.min(window.innerHeight, viewport.bottom, clip.bottom)
      && rect.right > Math.max(0, viewport.left, clip.left)
      && rect.left < Math.min(window.innerWidth, viewport.right, clip.right);
  });
}

/** Promote only this viewport. Never restore lazy: a timed-out image must keep loading. */
export function waitForViewportImages(host: HTMLElement, ready: () => void, capMs = IMAGE_READY_CAP_MS) {
  let stopped = false;
  const pending = new Map<HTMLImageElement, {src: string; done: boolean}>();
  const listeners: (() => void)[] = [];
  const stop = () => {
    stopped = true;
    window.clearTimeout(timer);
    observer.disconnect();
    listeners.forEach(remove => remove());
  };
  const finish = () => { if (!stopped) { stop(); ready(); } };
  const check = () => {
    if (stopped) return;
    const images = viewportImages(host);
    for (const image of images) {
      const src = `${image.src}|${image.srcset}`;
      if (pending.get(image)?.src === src) continue;
      const entry = {src, done: false};
      pending.set(image, entry);
      if (image.loading !== 'eager') image.loading = 'eager';
      const settled = () => { entry.done = true; check(); };
      if (typeof image.decode === 'function') void image.decode().then(() => {
        if (`${image.src}|${image.srcset}` === src) decodedImages.set(image, src);
        settled();
      }, settled);
      else if (image.complete) entry.done = true;
      else {
        image.addEventListener('load', settled, {once: true});
        image.addEventListener('error', settled, {once: true});
        listeners.push(() => { image.removeEventListener('load', settled); image.removeEventListener('error', settled); });
      }
    }
    if (images.every(image => pending.get(image)?.done)) finish();
  };
  const observer = new MutationObserver(check);
  observer.observe(host, {subtree: true, childList: true, attributes: true, attributeFilter: ['src', 'srcset']});
  const timer = window.setTimeout(finish, capMs);
  check();
  return stop;
}

/**
 * Loads and decodes `urls` before content that shows them commits (the old content stays painted
 * meanwhile), resolving after all decode or after `capMs`, whichever is first. Never rejects.
 */
export function preloadImages(urls: readonly string[], capMs = IMAGE_READY_CAP_MS) {
  if (!urls.length || typeof Image !== 'function') return Promise.resolve();
  let timer = 0;
  const decoded = Promise.all(urls.map(url => {
    const image = new Image();
    image.decoding = 'async';
    image.src = url;
    return (typeof image.decode === 'function' ? image.decode() : Promise.resolve()).catch(() => undefined);
  }));
  return Promise.race([decoded, new Promise<void>(resolve => { timer = window.setTimeout(resolve, capMs); })]).then(() => undefined).finally(() => window.clearTimeout(timer));
}
