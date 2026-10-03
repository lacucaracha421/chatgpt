import { useEffect, useRef, useState } from "react";
import type { CloudSyncHoldStatus } from "../library/types";
import { SettingsRow } from "../shared/ui/SettingsRow";
import { Button } from "../shared/ui/Button";
import { notifyCloudBackfillSupervisor } from "../app/useCloudBackfillSupervisor";

type Props = {
  endpoint: string;
  read: (endpoint: string) => Promise<CloudSyncHoldStatus>;
  save: (endpoint: string, held: boolean) => Promise<CloudSyncHoldStatus>;
};

export function CloudSyncHold({ endpoint, read, save }: Props) {
  const [value, setValue] = useState<{ endpoint: string; status: CloudSyncHoldStatus } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const currentEndpoint = useRef(endpoint);
  currentEndpoint.current = endpoint;
  useEffect(() => {
    let active = true;
    void read(endpoint).then(status => {
      if (active) { setValue({ endpoint, status }); setError(null); }
    }).catch(() => { if (active) setError("송신 보류 상태를 확인하지 못했습니다."); });
    return () => { active = false; };
  }, [endpoint, read]);
  const change = async (held: boolean) => {
    setBusy(true);
    try {
      const status = await save(endpoint, held);
      if (currentEndpoint.current === endpoint) { setValue({ endpoint, status }); setError(null); }
      notifyCloudBackfillSupervisor();
    } catch { setError("송신 보류 설정을 저장하지 못했습니다."); }
    finally { setBusy(false); }
  };
  const status = value?.status;
  return <SettingsRow name="이 PC의 동기화" value={<span role="status">
    {status && <span>{status.held ? "받기만" : "받기·보내기"}</span>}
    {status?.releaseAfterRestart && <> · <span>재시작 후 해제</span></>}
    {status?.held && !!status.tabletWait?.count && <span> · 태블릿 변경 {status.tabletWait.count.toLocaleString()}개가 누락된 항목을 기다립니다 · {status.tabletWait.targetIds.join(", ")}</span>}
    {error && <span>{error}</span>}
  </span>} control={<Button variant="quiet" disabled={busy || !status || value?.endpoint !== endpoint || !!error}
    onClick={() => void change(!status?.held || !!status?.releaseAfterRestart)}>
    {status?.releaseAfterRestart ? "해제 취소" : status?.held ? "보류 해제" : "송신 보류"}
  </Button>} />;
}
