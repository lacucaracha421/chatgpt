import { CHARACTER_SUGGESTIONS_CHANGED_EVENT } from "./suggestions/client";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useOptionalLibrary } from "../library/LibraryContext";
import { NO_SERIES_REVISIONS, publishSeriesDataRevision, type SeriesRevisions } from "./seriesMountCache";
import { characterApi, type CharacterTarget } from "./api";
import { characterHubApi, type CharacterGroup, type CharacterSeries } from "./hubApi";
import { commandErrorMessage } from "../library/errorMessage";
import { withGroupOrder } from "./groupOrder";

/** Keep the current value when a re-read returned the same data, so dependents do not re-run. */
function same<T>(current: T, next: T): T {
  return current === next || JSON.stringify(current) === JSON.stringify(next) ? current : next;
}

export function useCharacterHub(refreshVersion: number) {
  const [targets, setTargets] = useState<CharacterTarget[]>([]);
  // 기타 buckets are kept apart: every other screen lists characters only.
  const [extras, setExtras] = useState<CharacterTarget[]>([]);
  const [series, setSeries] = useState<CharacterSeries[]>([]);
  const [storedGroups, setGroups] = useState<CharacterGroup[]>([]);
  // The order just chosen per series: shown at once, and kept over later reads until the library changes.
  const [groupOrders, setGroupOrders] = useState<Record<string, string[]>>({});
  const [error, setError] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);
  const [seriesRevisions, setSeriesRevisions] = useState<SeriesRevisions>(NO_SERIES_REVISIONS);
  const library = useOptionalLibrary();
  const pending = useRef<{ key: string; gateway: unknown; read: Promise<{ targets: CharacterTarget[]; series: CharacterSeries[]; groups: CharacterGroup[] }> } | null>(null);
  useLayoutEffect(() => {
    if (library) return publishSeriesDataRevision(library.gateway, library.library?.root, refreshVersion + revision, seriesRevisions);
  }, [library?.gateway, library?.library?.root, refreshVersion, revision, seriesRevisions]);
  const refresh = useCallback(() => setRevision(v => v + 1), []);
  const ordersRef = useRef(groupOrders);
  ordersRef.current = groupOrders;
  const libraryRoot = library?.library?.root;
  useEffect(() => setGroupOrders({}), [libraryRoot]);
  const groups = useMemo(
    () => Object.entries(groupOrders).reduce((current, [seriesId, ids]) => withGroupOrder(current, seriesId, ids), storedGroups),
    [storedGroups, groupOrders],
  );
  /** Shows the new order of one series' groups at once and stores it; the old order returns, and the error is thrown, when storing fails. */
  const reorderGroups = useCallback(async (seriesId: string, ids: string[]) => {
    const previous = ordersRef.current[seriesId];
    setGroupOrders(current => ({ ...current, [seriesId]: ids }));
    try {
      await characterHubApi.reorderGroups(seriesId, ids);
      refresh();
    } catch (error) {
      setGroupOrders(current => {
        const { [seriesId]: _failed, ...rest } = current;
        return previous ? { ...rest, [seriesId]: previous } : rest;
      });
      refresh();
      throw error;
    }
  }, [refresh]);
  /** Analysis changed these series' members: their galleries and counts refresh, the hub does not. */
  const seriesAnalysed = useCallback((ids: readonly string[]) => {
    if (ids.length === 0) return;
    setSeriesRevisions(current => {
      const next = { ...current };
      for (const id of ids) next[id] = (next[id] ?? 0) + 1;
      return next;
    });
  }, []);
  useEffect(() => {
    window.addEventListener(CHARACTER_SUGGESTIONS_CHANGED_EVENT, refresh);
    return () => window.removeEventListener(CHARACTER_SUGGESTIONS_CHANGED_EVENT, refresh);
  }, [refresh]);
  useEffect(() => {
    let active = true;
    const key = JSON.stringify([library?.library?.root, refreshVersion, revision]);
    const gateway = library?.gateway;
    if (pending.current?.key !== key || pending.current.gateway !== gateway) {
      const read = Promise.all([characterApi.targets(), characterHubApi.series(), characterHubApi.allGroups()])
        .then(([targets, series, groups]) => ({ targets, series, groups }));
      const request = { key, gateway, read };
      pending.current = request;
      const clear = () => { if (pending.current === request) pending.current = null; };
      void read.then(clear, clear);
    }
    void pending.current.read.then(({ targets, series, groups }) => {
      if (active) {
        setTargets(current => same(current, targets.filter(target => target.role !== "extras")));
        setExtras(current => same(current, targets.filter(target => target.role === "extras")));
        setSeries(current => same(current, series)); setGroups(current => same(current, groups)); setError(null);
      }
    }).catch(e => { if (active) setError(commandErrorMessage(e, "캐릭터 목록을 불러오지 못했습니다.")); });
    return () => { active = false; };
  }, [library?.gateway, library?.library?.root, refreshVersion, revision]);
  return { targets, extras, series, groups, reorderGroups, error, refresh, revision, seriesRevisions, seriesAnalysed };
}
