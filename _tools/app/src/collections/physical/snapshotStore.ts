import type { RenderResult } from "./RenderCache";
/** Finished collectible renders kept across app sessions, outside the library database. */
export type SnapshotStore = {
  get(key: string): Promise<RenderResult | null>;
  put(key: string, value: RenderResult): void;
};
export const SNAPSHOT_STORE_BUDGET = 64 * 1024 * 1024;
// Bump when the stored format or the renderers change: the upgrade drops every older snapshot.
// Render keys also carry their renderer tag, so a stale key simply ages out of the LRU.
const DB_NAME = "lakomics-collectible-snapshots", DB_VERSION = 1, WRITE_DELAY_MS = 400;
type Meta = { key: string; bytes: number; used: number };
type Stored = { key: string; data: ArrayBuffer; type: string; width: number; height: number };

/** Keys to delete so the most recently used snapshots fit the byte budget. */
export function planEviction(metas: readonly Meta[], budget: number): string[] {
  let total = 0;
  return [...metas].sort((a, b) => b.used - a.used).filter(meta => (total += meta.bytes) > budget).map(meta => meta.key);
}

/** IndexedDB works for the app origin in both WebKitGTK and WebView2; any failure just means "render again". */
export function createSnapshotStore(budget = SNAPSHOT_STORE_BUDGET): SnapshotStore | null {
  if (typeof indexedDB === "undefined") return null;
  let opened: Promise<IDBDatabase | null> | null = null;
  const reads = new Map<string, Array<(value: RenderResult | null) => void>>();
  const writes = new Map<string, Stored>(), touched = new Set<string>();
  let readTimer: ReturnType<typeof setTimeout> | null = null, writeTimer: ReturnType<typeof setTimeout> | null = null;
  function database() {
    opened ??= new Promise<IDBDatabase | null>(resolve => {
      try {
        const request = indexedDB.open(DB_NAME, DB_VERSION);
        request.onupgradeneeded = () => {
          const db = request.result;
          for (const name of [...db.objectStoreNames]) db.deleteObjectStore(name);
          db.createObjectStore("snapshots", { keyPath: "key" });
          db.createObjectStore("meta", { keyPath: "key" }).createIndex("used", "used");
        };
        request.onsuccess = () => { const db = request.result; db.onversionchange = () => { db.close(); opened = null; }; resolve(db); };
        request.onerror = request.onblocked = () => resolve(null);
      } catch { resolve(null); }
    });
    return opened;
  }
  // One read-only transaction per burst of lookups (a screenful mounts together).
  async function flushReads() {
    readTimer = null;
    const batch = new Map(reads); reads.clear();
    const finish = (key: string, value: RenderResult | null) => { for (const resolve of batch.get(key) ?? []) resolve(value); };
    const done = new Set<string>();
    const db = await database().catch(() => null);
    try {
      if (!db) throw new Error("Snapshot store unavailable");
      const store = db.transaction("snapshots", "readonly").objectStore("snapshots");
      await Promise.all([...batch.keys()].map(key => new Promise<void>(resolve => {
        const request = store.get(key);
        request.onsuccess = () => {
          const stored = request.result as Stored | undefined;
          done.add(key);
          if (stored) { touched.add(key); scheduleWrite(); }
          finish(key, stored ? { blob: new Blob([stored.data], { type: stored.type }), width: stored.width, height: stored.height } : null);
          resolve();
        };
        request.onerror = () => resolve();
      })));
    } catch { /* treated as misses below */ }
    for (const key of batch.keys()) if (!done.has(key)) finish(key, null);
  }
  function scheduleWrite() { writeTimer ??= setTimeout(() => { void flushWrites(); }, WRITE_DELAY_MS); }
  async function flushWrites() {
    writeTimer = null;
    const puts = [...writes.values()], touches = [...touched].filter(key => !writes.has(key));
    writes.clear(); touched.clear();
    const db = await database().catch(() => null);
    if (!db) return;
    try {
      const transaction = db.transaction(["snapshots", "meta"], "readwrite");
      const snapshots = transaction.objectStore("snapshots"), meta = transaction.objectStore("meta"), now = Date.now();
      for (const stored of puts) { snapshots.put(stored); meta.put({ key: stored.key, bytes: stored.data.byteLength, used: now } satisfies Meta); }
      for (const key of touches) {
        const request = meta.get(key);
        request.onsuccess = () => { const current = request.result as Meta | undefined; if (current) meta.put({ ...current, used: now }); };
      }
      if (puts.length) {
        const all = meta.getAll();
        all.onsuccess = () => { for (const key of planEviction(all.result as Meta[], budget)) { snapshots.delete(key); meta.delete(key); } };
      }
    } catch { /* quota or closed database: the renders stay in memory only */ }
  }
  return {
    get(key) {
      return new Promise(resolve => {
        const waiting = reads.get(key);
        if (waiting) waiting.push(resolve); else reads.set(key, [resolve]);
        readTimer ??= setTimeout(() => { void flushReads(); }, 0);
      });
    },
    put(key, value) {
      void value.blob.arrayBuffer().then(data => {
        writes.set(key, { key, data, type: value.blob.type || "image/png", width: value.width, height: value.height });
        scheduleWrite();
      }, () => undefined);
    },
  };
}
