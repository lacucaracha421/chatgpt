import { useCallback, useEffect, useState } from "react";
import { characterApi, type CharacterTarget } from "./api";
import { characterHubApi, type CharacterSeries } from "./hubApi";
import { commandErrorMessage } from "../library/errorMessage";

export function useCharacterHub(refreshVersion: number) {
  const [targets, setTargets] = useState<CharacterTarget[]>([]);
  const [series, setSeries] = useState<CharacterSeries[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);
  const refresh = useCallback(() => setRevision(v => v + 1), []);
  useEffect(() => {
    let active = true;
    void Promise.all([characterApi.targets(), characterHubApi.series()]).then(([targets, series]) => {
      if (active) { setTargets(targets); setSeries(series); setError(null); }
    }).catch(e => { if (active) setError(commandErrorMessage(e, "캐릭터 목록을 불러오지 못했습니다.")); });
    return () => { active = false; };
  }, [refreshVersion, revision]);
  return { targets, series, error, refresh, revision };
}
