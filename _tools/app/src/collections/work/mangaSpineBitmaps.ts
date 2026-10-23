import { drawMangaSpine } from "./drawMangaSpine";
import { SpineBitmapLRU, spineBitmapKey, type SpineBitmapSpec } from "./mangaSpineBitmapCache";

export type SpineBitmap = { url: string; bytes: number; ratio: number | null };
const cache = new SpineBitmapLRU<SpineBitmap>(48 * 1024 * 1024, value => URL.revokeObjectURL(value.url));
type Consumer = { priority(): number; done(value: SpineBitmap): void; failed?(): void };
type Job = { key: string; spec: SpineBitmapSpec; consumers: Set<Consumer> };
const jobs = new Map<string, Job>();
let running = false, scheduled = false, scrollUntil = 0;

/** Only a timestamp: the shelf scroll handler never writes styles. */
export function noteMangaShelfScroll() { scrollUntil = performance.now() + 100; }

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image(); image.crossOrigin = "anonymous";
    image.onload = () => { void image.decode().then(() => resolve(image), reject); };
    image.onerror = () => reject(new Error("Spine image unavailable for canvas"));
    image.src = url;
  });
}

// The same SVG noise as --bk-print-grain; loaded once, not one filter per printed spine.
let grain: Promise<HTMLImageElement> | undefined;
const printGrain = () => grain ??= loadImage("data:image/svg+xml," + encodeURIComponent("<svg xmlns='http://www.w3.org/2000/svg' width='96' height='96'><filter id='n'><feTurbulence type='fractalNoise' baseFrequency='1.1' numOctaves='2' stitchTiles='stitch'/><feColorMatrix type='saturate' values='0'/></filter><rect width='96' height='96' filter='url(#n)'/></svg>"));

/** One non-preemptible spine per idle slice, never a burst during a wheel gesture. */
function idle(task: () => void) {
  const attempt = () => {
    const delay = scrollUntil - performance.now();
    if (delay > 0) { window.setTimeout(attempt, delay); return; }
    if (typeof window.requestIdleCallback === "function") {
      window.requestIdleCallback(deadline => {
        if (performance.now() < scrollUntil || deadline.timeRemaining() < 4) { window.setTimeout(attempt, 16); return; }
        task();
      });
    } else window.setTimeout(() => { if (performance.now() < scrollUntil) attempt(); else task(); }, 16);
  };
  attempt();
}

function schedule() {
  if (running || scheduled || !jobs.size) return;
  scheduled = true;
  idle(() => {
    scheduled = false;
    const priority = (job: Job) => Math.min(...[...job.consumers].map(consumer => consumer.priority()));
    const job = [...jobs.values()].filter(job => job.consumers.size).sort((a, b) => priority(a) - priority(b))[0];
    if (!job) return;
    running = true;
    void render(job).finally(() => { if (jobs.get(job.key) === job) jobs.delete(job.key); running = false; schedule(); });
  });
}

async function render(job: Job) {
  let url: string | null = null;
  try {
    const { spec } = job;
    // Only one job's sources are retained at a time, including original scans.
    const [art, scan, noise] = await Promise.all([
      !spec.privacy && !spec.scan && spec.art ? loadImage(spec.art) : null,
      !spec.privacy && spec.scan ? loadImage(spec.scan) : null,
      printGrain(), document.fonts?.ready,
    ]);
    if (!job.consumers.size) return;
    const drawn = await new Promise<ReturnType<typeof drawMangaSpine>>((resolve, reject) => idle(() => {
      try { resolve(drawMangaSpine(spec, art, scan, noise)); } catch (error) { reject(error); }
    }));
    const blob = await new Promise<Blob>((resolve, reject) => drawn.canvas.toBlob(value => value ? resolve(value) : reject(new Error("Spine encoding unavailable")), "image/png"));
    url = URL.createObjectURL(blob);
    const value = { url, ratio: drawn.ratio, bytes: drawn.canvas.width * drawn.canvas.height * 4 + blob.size };
    // Source canvases and scans can now be released. Actual DOM slots decode the blob before swapping.
    drawn.canvas.width = drawn.canvas.height = 0;
    await new Promise<void>(resolve => idle(() => {
      if (job.consumers.size && cache.set(job.key, value)) {
        url = null;
        job.consumers.forEach(consumer => consumer.done(value));
      } else job.consumers.forEach(consumer => consumer.failed?.());
      resolve();
    }));
  } catch {
    // Unsupported/tainted tablet canvas or unavailable media: restore/retain the DOM print.
    job.consumers.forEach(consumer => consumer.failed?.());
  }
  finally { if (url) URL.revokeObjectURL(url); }
}

export function requestSpineBitmap(spec: SpineBitmapSpec, consumer: Consumer): () => void {
  if (typeof Image.prototype.decode !== "function" || typeof HTMLCanvasElement.prototype.toBlob !== "function") {
    consumer.failed?.(); return () => {};
  }
  const key = spineBitmapKey(spec), hit = cache.get(key);
  if (hit) { consumer.done(hit); return () => {}; }
  let job = jobs.get(key);
  if (!job) { job = { key, spec, consumers: new Set() }; jobs.set(key, job); }
  job.consumers.add(consumer); schedule();
  return () => {
    job.consumers.delete(consumer);
    // Do not let obsolete offscreen work grow the queue indefinitely.
    if (!job.consumers.size && jobs.get(key) === job) jobs.delete(key);
  };
}
