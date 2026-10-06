import type { CloudBackfillProgress, LibraryGateway } from "../library/types";

const pending = new WeakMap<LibraryGateway, Map<string, Promise<CloudBackfillProgress>>>();

/** Share overlapping status reads, without caching completed state across user actions. */
export function readCloudProgress(gateway: LibraryGateway, root: string) {
  let roots = pending.get(gateway);
  if (!roots) { roots = new Map(); pending.set(gateway, roots); }
  const existing = roots.get(root);
  if (existing) return existing;
  const read = Promise.resolve().then(() => gateway.cloudBackfillProgress());
  roots.set(root, read);
  const clear = () => { if (roots.get(root) === read) roots.delete(root); };
  void read.then(clear, clear);
  return read;
}
