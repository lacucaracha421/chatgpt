import { CHARACTER_SUGGESTIONS_CHANGED_EVENT } from "./suggestions/client";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { useOptionalLibrary } from "../library/LibraryContext";
import { publishSeriesDataRevision } from "./seriesMountCache";
import { characterApi, type CharacterTarget } from "./api";
import { characterHubApi, type CharacterGroup, type CharacterSeries } from "./hubApi";
import { commandErrorMessage } from "../library/errorMessage";

export function useCharacterHub(refreshVersion: number) {
  const [targets, setTargets] = useState<CharacterTarget[]>([]);
  const [series, setSeries] = useState<CharacterSeries[]>([]);
  const [folderExclusions, setFolderExclusions] = useState<string[]>([]);
  const [groups, setGroups] = useState<CharacterGroup[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);
  const library = useOptionalLibrary();
  const pending = useRef<{ key: string; gateway: unknown; read: Promise<{ targets: CharacterTarget[]; series: CharacterSeries[]; folderExclusions: string[]; groups: CharacterGroup[] }> } | null>(null);
  useLayoutEffect(() => {
    if (library) return publishSeriesDataRevision(library.gateway, library.library?.root, refreshVersion + revision);
  }, [library?.gateway, library?.library?.root, refreshVersion, revision]);
  const refresh = useCallback(() => setRevision(v => v + 1), []);
  useEffect(() => {
    window.addEventListener(CHARACTER_SUGGESTIONS_CHANGED_EVENT, refresh);
    return () => window.removeEventListener(CHARACTER_SUGGESTIONS_CHANGED_EVENT, refresh);
  }, [refresh]);
  useEffect(() => {
    let active = true;
    const key = JSON.stringify([library?.library?.root, refreshVersion, revision]);
    const gateway = library?.gateway;
    if (pending.current?.key !== key || pending.current.gateway !== gateway) {
      const read = Promise.all([characterApi.targets(), characterHubApi.series(), characterHubApi.folderExclusions()]).then(async ([targets, series, folderExclusions]) => {
        // A newer snapshot already owns the result; do not fan out obsolete group reads.
        if (pending.current?.key !== key || pending.current.gateway !== gateway) {
          return { targets, series, folderExclusions, groups: [] };
        }
        const ids = [...new Set(series.map(item => item.classificationId))];
        const groups = (await Promise.all(ids.map(id => characterHubApi.groups(id)))).flat();
        return { targets, series, folderExclusions, groups };
      });
      const request = { key, gateway, read };
      pending.current = request;
      const clear = () => { if (pending.current === request) pending.current = null; };
      void read.then(clear, clear);
    }
    void pending.current.read.then(({ targets, series, folderExclusions, groups }) => {
      if (active) { setFolderExclusions(folderExclusions); setTargets(targets); setSeries(series); setGroups(groups); setError(null); }
    }).catch(e => { if (active) setError(commandErrorMessage(e, "캐릭터 목록을 불러오지 못했습니다.")); });
    return () => { active = false; };
  }, [library?.gateway, library?.library?.root, refreshVersion, revision]);
  return { targets, series, groups, folderExclusions, error, refresh, revision };
}
