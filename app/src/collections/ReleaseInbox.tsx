import { useEffect, useState } from "react";
import { useLibrary } from "../library/LibraryContext";
import type { ReleaseInboxItem } from "../library/types";
import { commandErrorMessage } from "../library/errorMessage";
import { Button } from "../shared/ui/Button";
import { Dialog } from "../shared/ui/Dialog";
import { ReleaseWatchSummary } from "./ReleaseWatchSummary";

const STOP_REASON: Record<string, string> = {
  credential_not_configured: "카카오 연결 설정이 필요합니다.", invalid_credential: "카카오 인증 정보를 확인해 주세요.",
  rate_limited: "요청 한도에 도달했습니다. 잠시 후 다시 확인해 주세요.", timed_out: "응답 시간이 초과됐습니다.",
  unavailable: "출간 정보 서비스에 연결하지 못했습니다.", invalid_response: "출간 정보 응답을 읽지 못했습니다.",
};

export function ReleaseInbox({ onClose, onChanged }: { onClose: () => void; onChanged: () => void | Promise<void> }) {
  const { gateway } = useLibrary();
  const api = gateway.collectionTracking;
  const [items, setItems] = useState<ReleaseInboxItem[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  useEffect(() => {
    let active = true;
    if (api) void api.listInbox().then(value => { if (active) setItems(value); }, err => { if (active) setError(commandErrorMessage(err, "알림을 불러오지 못했습니다.")); });
    return () => { active = false; };
  }, [api]);
  async function handle(item: ReleaseInboxItem) {
    if (!api || busy) return;
    setBusy(true); setError(null);
    try {
      await api.acknowledge(item.collectionId, [item.event.id]);
      setItems(current => current?.filter(entry => entry.event.id !== item.event.id) ?? null);
      void Promise.resolve(onChanged()).catch(() => undefined);
    } catch (err) { setError(commandErrorMessage(err, "알림을 처리하지 못했습니다.")); }
    finally { setBusy(false); }
  }
  async function check() {
    if (!api || busy) return;
    setBusy(true); setError(null); setMessage(null);
    try {
      const result = await gateway.runDueReleaseWatch();
      setItems(await api.listInbox());
      setMessage(result.stopReason ? `확인을 마치지 못했습니다: ${STOP_REASON[result.stopReason] ?? "잠시 후 다시 확인해 주세요."}` : `${result.checked}개 작품 확인 · 새 출간 정보 ${result.changedCollections}개 작품`);
      void Promise.resolve(onChanged()).catch(() => undefined);
    } catch (err) { setError(commandErrorMessage(err, "신간 확인에 실패했습니다.")); }
    finally { setBusy(false); }
  }
  return <Dialog open title="신간 알림함" variant="medium" onClose={onClose}>
    <p>직접 확인할 때까지 알림이 남습니다. 확인한 뒤에도 미보유 권은 보유 관리에서 볼 수 있습니다.</p>
    <p>앱이 실행 중일 때 하루 간격으로 조회합니다. 아래 버튼은 확인할 시각이 된 작품을 조회합니다.</p>
    <Button disabled={busy} onClick={() => void check()}>신간 확인</Button>
    {message && <p role="status">{message}</p>}{error && <p role="alert">{error}</p>}
    <div className="release-inbox__items">
      {items === null && !error && <p>알림 불러오는 중…</p>}
      {items?.length === 0 && <p>확인하지 않은 신간 알림이 없습니다.</p>}
      {items?.map(item => <article key={item.event.id} className="release-inbox__item">
        <strong>{item.collectionName}</strong><ReleaseWatchSummary events={[item.event]} />
        <small>발견 {new Date(item.event.detectedAt).toLocaleString("ko-KR")}</small>
        <div className="release-inbox__actions">
          <Button size="sm" disabled={busy} onClick={() => void handle(item)}>확인</Button>
        </div>
      </article>)}
    </div>
  </Dialog>;
}
