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

/** Idle slices only, never during a wheel gesture. */
function idle(task: () => void) {
  const attempt = () => {
    const delay = scrollUntil - performance.now();
    if (delay > 0) { window.setTimeout(attempt, delay); return; }
    if (typeof window.requestIdleCallback === "function") {
      window.requestIdleCallback(() => {
        if (performance.now() < scrollUntil) { window.setTimeout(attempt, 16); return; }
        task();
      });
    } else window.setTimeout(() => { if (performance.now() < scrollUntil) attempt(); else task(); }, 16);
  };
  attempt();
}

// Up to BATCH spines load their sources together; drawing then fills each idle slice up to its budget.
const BATCH = 12;
function schedule() {
  if (running || scheduled || !jobs.size) return;
  scheduled = true;
  idle(() => {
    scheduled = false;
    const priority = (job: Job) => Math.min(...[...job.consumers].map(consumer => consumer.priority()));
    const batch = [...jobs.values()].filter(job => job.consumers.size).sort((a, b) => priority(a) - priority(b)).slice(0, BATCH);
    if (!batch.length) return;
    running = true;
    void renderBatch(batch).finally(() => {
      batch.forEach(job => { if (jobs.get(job.key) === job) jobs.delete(job.key); });
      running = false; schedule();
    });
  });
}

type Loaded = { job: Job; art: HTMLImageElement | null; scan: HTMLImageElement | null; noise: HTMLImageElement };
async function load(job: Job): Promise<Loaded | null> {
  const { spec } = job;
  try {
    const [art, scan, noise] = await Promise.all([
      !spec.privacy && !spec.scan && spec.art ? loadImage(spec.art) : null,
      !spec.privacy && spec.scan ? loadImage(spec.scan) : null,
      printGrain(), document.fonts?.ready,
    ]);
    return { job, art, scan, noise };
  } catch {
    // Unsupported/tainted tablet canvas or unavailable media: restore/retain the DOM print.
    job.consumers.forEach(consumer => consumer.failed?.());
    return null;
  }
}

async function renderBatch(batch: Job[]) {
  const loaded = (await Promise.all(batch.map(load))).filter((item): item is Loaded => Boolean(item && item.job.consumers.size));
  let next = 0;
  const finishing: Promise<void>[] = [];
  while (next < loaded.length) {
    await new Promise<void>(resolve => idle(() => {
      // Draw as many as this slice allows (at least one), never a long task.
      const until = performance.now() + 10;
      do { finishing.push(finish(loaded[next++])); } while (next < loaded.length && performance.now() < until);
      resolve();
    }));
  }
  await Promise.all(finishing);
}

async function finish({ job, art, scan, noise }: Loaded) {
  let url: string | null = null;
  try {
    if (!job.consumers.size) return;
    const drawn = drawMangaSpine(job.spec, art, scan, noise);
    const blob = await new Promise<Blob>((resolve, reject) => drawn.canvas.toBlob(value => value ? resolve(value) : reject(new Error("Spine encoding unavailable")), "image/png"));
    url = URL.createObjectURL(blob);
    const value = { url, ratio: drawn.ratio, bytes: drawn.canvas.width * drawn.canvas.height * 4 + blob.size };
    // Source canvases can now be released. Actual DOM slots decode the blob before swapping.
    drawn.canvas.width = drawn.canvas.height = 0;
    if (job.consumers.size && cache.set(job.key, value)) {
      url = null;
      job.consumers.forEach(consumer => consumer.done(value));
    } else job.consumers.forEach(consumer => consumer.failed?.());
  } catch {
    job.consumers.forEach(consumer => consumer.failed?.());
  } finally { if (url) URL.revokeObjectURL(url); }
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
