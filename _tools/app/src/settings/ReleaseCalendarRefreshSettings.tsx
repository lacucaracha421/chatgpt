import { useEffect, useState } from "react";
import { RELEASE_SOURCE_PROBLEM } from "../collections/releaseCalendarFormat";
import { useLibrary } from "../library/LibraryContext";
import { commandErrorMessage } from "../library/errorMessage";
import type { ReleaseCalendar } from "../library/types";
import { Button } from "../shared/ui/Button";

const SOURCE_LABEL = { igdb: "게임", tmdb: "영화", tmdb_tv: "애니" } as const;

/** Settings › 외부 서비스: refetch the 발매 캘린더 now, without the daily limit. */
export function ReleaseCalendarRefreshSettings() {
  const { gateway } = useLibrary();
  const api = gateway.releaseCalendar;
  const [calendar, setCalendar] = useState<ReleaseCalendar | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    void api?.calendar().then(value => { if (active) setCalendar(value); }).catch(() => undefined);
    return () => { active = false; };
  }, [api]);

  if (!api) return null;

  async function refreshNow() {
    if (!api || busy) return;
    setBusy(true); setMessage(null);
    try {
      const fresh = await api.refreshNow();
      setCalendar(fresh);
      const failed = fresh.sources.filter(source => source.errorCode);
      setMessage(failed.length ? "일부 서비스에서 받지 못했습니다." : `${fresh.entries.length.toLocaleString()}개 작품을 새로 받았습니다.`);
    } catch (err) {
      setMessage(commandErrorMessage(err, "발매 캘린더를 새로 받지 못했습니다."));
    } finally { setBusy(false); }
  }

  return <dl className="settings-view__property">
    <dt>발매 캘린더</dt>
    <dd className="settings-view__credential-status">평소에는 하루에 한 번 자동으로 받습니다. 누르면 기다리지 않고 게임·영화·애니 발매 정보를 지금 다시 받습니다.</dd>
    {calendar?.sources.map(source => <dd key={source.provider} className="settings-view__row-note">
      {SOURCE_LABEL[source.provider]} · {source.fetchedAt ? `마지막으로 받음 ${new Date(source.fetchedAt).toLocaleString("ko-KR")}` : "받은 기록 없음"}
      {source.errorCode && ` · ${RELEASE_SOURCE_PROBLEM[source.errorCode] ?? "받지 못했습니다."}`}
    </dd>)}
    <Button size="sm" disabled={busy} onClick={() => void refreshNow()}>{busy ? "받는 중…" : "지금 새로 받기"}</Button>
    {message && <dd className="settings-view__row-message" role="status">{message}</dd>}
  </dl>;
}
