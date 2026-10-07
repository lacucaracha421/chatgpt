/** Counts from already-read PC trash pages; navigation never starts a cloud read. */
const collectionCounts = new Map<string, number>();
const listeners = new Set<() => void>();
export function collectionTrashCount(root: string): number {
  return collectionCounts.get(root) ?? 0;
}
export function setCollectionTrashCount(root: string, count: number) {
  if (collectionCounts.get(root) === count) return;
  collectionCounts.set(root, count);
  listeners.forEach(listener => listener());
}
export function subscribeTrashCounts(listener: () => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
