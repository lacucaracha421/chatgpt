import type { CharacterSidebarCounts, LibraryGateway } from "../library/types";
import { onFolderPrefetchInvalidated } from "../assets/folderPrefetch";

type Entry<T> = { promise: Promise<T>; value?: T };
type Scope<T> = { version: number; generation: number; entries: Map<string, Entry<T>> };

/** Session reads shared by mounts. Keep only the current data revision; failed reads are retryable. */
export class RevisionReadCache<T> {
  private sources = new WeakMap<object, Map<string, Scope<T>>>();
  private listeners = new Set<() => void>();
  private epoch = 0;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private scope(source: object, key: string) {
    let scopes = this.sources.get(source);
    if (!scopes) this.sources.set(source, scopes = new Map());
    let scope = scopes.get(key);
    if (!scope) scopes.set(key, scope = { version: -1, generation: 0, entries: new Map() });
    return scope;
  }
  generation(source: object, key: string) { return `${this.epoch}:${this.scope(source, key).generation}`; }
  peek(source: object, key: string, version: number, args = "") {
    const scope = this.scope(source, key);
    return scope.version === version ? scope.entries.get(args)?.value : undefined;
  }
  read(source: object, key: string, version: number, args: string, read: () => Promise<T>): Promise<T> {
    const scope = this.scope(source, key);
    if (scope.version !== version) { scope.version = version; scope.entries.clear(); }
    const existing = scope.entries.get(args);
    if (existing) return existing.promise;
    const entry: Entry<T> = { promise: read() };
    scope.entries.set(args, entry);
    void entry.promise.then(value => { entry.value = value; }, () => {
      if (scope.entries.get(args) === entry) scope.entries.delete(args);
    });
    return entry.promise;
  }
  /** Re-read one entry in place: peek() keeps answering with the value it replaces until the read lands. */
  refresh(source: object, key: string, version: number, args: string, read: () => Promise<T>): Promise<T> {
    const scope = this.scope(source, key);
    const previous = scope.version === version ? scope.entries.get(args) : undefined;
    if (!previous || previous.value === undefined) return this.read(source, key, version, args, read);
    const entry: Entry<T> = { promise: read(), value: previous.value };
    scope.entries.set(args, entry);
    void entry.promise.then(value => { entry.value = value; }, () => {
      if (scope.entries.get(args) === entry) scope.entries.set(args, previous);
    });
    return entry.promise;
  }
  invalidate(source: object, key: string) {
    const scope = this.scope(source, key);
    scope.entries.clear(); scope.generation += 1;
    this.listeners.forEach(listener => listener());
  }
  clear() {
    this.sources = new WeakMap(); this.epoch += 1;
    this.listeners.forEach(listener => listener());
  }
}

const gatewayIds = new WeakMap<object, number>();
let nextGatewayId = 0;
export function seriesDataScope(gateway?: object, root?: string) {
  if (!gateway) return "";
  let id = gatewayIds.get(gateway);
  if (id === undefined) { id = ++nextGatewayId; gatewayIds.set(gateway, id); }
  return JSON.stringify([id, root ?? null]);
}

/** Automatic analysis results per series id (useCharacterHub); they change members, not definitions. */
export type SeriesRevisions = Readonly<Record<string, number>>;
export const NO_SERIES_REVISIONS: SeriesRevisions = {};

// The App planner cannot receive extra props: the already-mounted hub publishes its existing revision.
const hubRevisions = new WeakMap<object, { scope: string; version: number; seriesRevisions: SeriesRevisions }>();
export function publishSeriesDataRevision(gateway: object, root: string | undefined, version: number, seriesRevisions: SeriesRevisions = NO_SERIES_REVISIONS) {
  const revision = { scope: seriesDataScope(gateway, root), version, seriesRevisions };
  hubRevisions.set(gateway, revision);
  return () => { if (hubRevisions.get(gateway) === revision) hubRevisions.delete(gateway); };
}
export const seriesDataRevision = (gateway: object) => hubRevisions.get(gateway);
export const sidebarCountCache = new RevisionReadCache<CharacterSidebarCounts>();
onFolderPrefetchInvalidated(() => sidebarCountCache.clear());
// The series revisions each cached count read started under. Counts are one read for every series,
// but analysis changes one series at a time: only a series whose revision moved since re-reads them.
const countRevisions = new WeakMap<object, Map<string, SeriesRevisions>>();
/** Sidebar counts for `scope`; with `series`, re-read in place when that series was analysed since. */
export function readSeriesSidebarCounts(gateway: LibraryGateway, scope: string, version: number, series?: { id: string; revisions: SeriesRevisions }) {
  if (!gateway.characterSidebarCounts) return Promise.resolve(undefined);
  let seen = countRevisions.get(gateway);
  if (!seen) countRevisions.set(gateway, seen = new Map());
  const started = seen;
  const read = () => {
    started.set(scope, series?.revisions ?? {});
    return gateway.characterSidebarCounts!();
  };
  const previous = seen.get(scope);
  const stale = series !== undefined && previous !== undefined
    && (previous[series.id] ?? 0) !== (series.revisions[series.id] ?? 0);
  return stale
    ? sidebarCountCache.refresh(gateway, scope, version, "", read)
    : sidebarCountCache.read(gateway, scope, version, "", read);
}
