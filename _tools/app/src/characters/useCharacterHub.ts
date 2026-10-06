import { CHARACTER_SUGGESTIONS_CHANGED_EVENT } from "./suggestions/client";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { useOptionalLibrary } from "../library/LibraryContext";
import { NO_SERIES_REVISIONS, publishSeriesDataRevision, type SeriesRevisions } from "./seriesMountCache";
import { characterApi, type CharacterTarget } from "./api";
import { characterHubApi, type CharacterGroup, type CharacterSeries } from "./hubApi";
import { commandErrorMessage } from "../library/errorMessage";

/** Keep the current value when a re-read returned the same data, so dependents do not re-run. */
function same<T>(current: T, next: T): T {
  return current === next || JSON.stringify(current) === JSON.stringify(next) ? current : next;
}

export function useCharacterHub(refreshVersion: number) {
  const [targets, setTargets] = useState<CharacterTarget[]>([]);
  const [series, setSeries] = useState<CharacterSeries[]>([]);
  const [folderExclusions, setFolderExclusions] = useState<string[]>([]);
  const [groups, setGroups] = useState<CharacterGroup[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);
  const [seriesRevisions, setSeriesRevisions] = useState<SeriesRevisions>(NO_SERIES_REVISIONS);
  const library = useOptionalLibrary();
  const pending = useRef<{ key: string; gateway: unknown; read: Promise<{ targets: CharacterTarget[]; series: CharacterSeries[]; folderExclusions: string[]; groups: CharacterGroup[] }> } | null>(null);
  useLayoutEffect(() => {
    if (library) return publishSeriesDataRevision(library.gateway, library.library?.root, refreshVersion + revision, seriesRevisions);
  }, [library?.gateway, library?.library?.root, refreshVersion, revision, seriesRevisions]);
  const refresh = useCallback(() => setRevision(v => v + 1), []);
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
      const read = Promise.all([characterApi.targets(), characterHubApi.series(), characterHubApi.folderExclusions(), characterHubApi.allGroups()])
        .then(([targets, series, folderExclusions, groups]) => ({ targets, series, folderExclusions, groups }));
      const request = { key, gateway, read };
      pending.current = request;
      const clear = () => { if (pending.current === request) pending.current = null; };
      void read.then(clear, clear);
    }
    void pending.current.read.then(({ targets, series, folderExclusions, groups }) => {
      if (active) {
        setFolderExclusions(current => same(current, folderExclusions)); setTargets(current => same(current, targets));
        setSeries(current => same(current, series)); setGroups(current => same(current, groups)); setError(null);
      }
    }).catch(e => { if (active) setError(commandErrorMessage(e, "캐릭터 목록을 불러오지 못했습니다.")); });
    return () => { active = false; };
  }, [library?.gateway, library?.library?.root, refreshVersion, revision]);
  return { targets, series, groups, folderExclusions, error, refresh, revision, seriesRevisions, seriesAnalysed };
}
