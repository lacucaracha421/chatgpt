import { useCallback, useEffect, useState } from "react";
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
  const refresh = useCallback(() => setRevision(v => v + 1), []);
  useEffect(() => {
    let active = true;
    void Promise.all([characterApi.targets(), characterHubApi.series(), characterHubApi.folderExclusions()]).then(async ([targets, series, folderExclusions]) => {
      const groups = (await Promise.all(series.map(item => characterHubApi.groups(item.classificationId)))).flat();
      if (active) { setFolderExclusions(folderExclusions); setTargets(targets); setSeries(series); setGroups(groups); setError(null); }
    }).catch(e => { if (active) setError(commandErrorMessage(e, "캐릭터 목록을 불러오지 못했습니다.")); });
    return () => { active = false; };
  }, [refreshVersion, revision]);
  return { targets, series, groups, folderExclusions, error, refresh, revision };
}
