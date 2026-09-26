import { useEffect, useRef, useState, type ReactNode } from "react";
import { getWorkloadProfile, useWorkloadProfile } from "../app/workloadProfile";
import { useLibrary } from "../library/LibraryContext";
import { commandErrorMessage } from "../library/errorMessage";
import type { CollectionSummary, CollectionUpdateFailure, CollectionUpdateProvider, CollectionUpdateStatus, ReleaseInboxItem } from "../library/types";
import { usePrivacy } from "../privacy/PrivacyContext";
import { Button } from "../shared/ui/Button";
import { Dialog } from "../shared/ui/Dialog";
import { EmptyState } from "../shared/ui/EmptyState";
import { groupInbox, japanReleases, koreanReleases, koreanVolumeLine, localDay, releaseLine } from "./releaseCaption";
import { updateCachedInbox, type ReleaseData } from "./releaseData";
import "./collectionReleases.css";
import { createKoreanMatcher } from "../shared/koreanSearch";

/** Volumes ahead of the Korean edition shown as chips before the rest fold into "외 N권". */
const AHEAD_CHIPS = 16;

const STOP_REASON: Record<string, string> = {
  credential_not_configured: "카카오 연결 설정이 필요합니다.", invalid_credential: "카카오 인증 정보를 확인해 주세요.",
  rate_limited: "요청 한도에 도달했습니다.", timed_out: "응답 시간이 초과됐습니다.",
  unavailable: "서비스에 연결하지 못했습니다.", invalid_response: "응답을 읽지 못했습니다.",
};
function failureDescription(failure: CollectionUpdateFailure): string {
  const stage = ({ detail: "작품 정보 조회", covers: "표지 목록 조회", search: "검색", image: "표지 이미지 조회", refresh: "작품 갱신" } as Record<string, string>)[failure.endpoint] ?? "작품 갱신";
  const code = failure.httpStatus;
  const message = code ? `HTTP ${code} · ${code === 429 ? "요청 한도 초과" : code === 401 || code === 403 ? "서버가 접근을 거부했습니다" : code >= 500 ? "서버 오류" : code === 408 ? "응답 시간 초과" : "요청이 거부됐습니다"}` : ({
    dns: "서버 주소를 찾지 못했습니다", tls: "보안 연결에 실패했습니다", timeout: "응답 시간이 초과됐습니다",
    connection: "연결이 끊겼거나 요청을 보내지 못했습니다", body: "응답을 받는 도중 연결이 끊겼습니다",
    invalid_response: "응답 형식을 읽지 못했습니다", not_found: "작품을 찾을 수 없습니다",
  } as Record<string, string>)[failure.kind] ?? "상세 원인을 확인하지 못했습니다";
  return `${stage} · ${message}`;
}

type Props = {
  /** kakao = 한국 정발, mangadex = 일본 (the update provider each segment checks). */
  provider: CollectionUpdateProvider;
  collections: CollectionSummary[];
  data: ReleaseData | null;
  loading: boolean;
  error: unknown;
  query?: string;
  coverUrl: (collection: CollectionSummary) => string | null;
  onOpen: (collectionId: string) => void;
  onChanged: () => void | Promise<void>;
  onProviderChange: (provider: CollectionUpdateProvider) => void;
};

/**
 * The 신간 view, as on the tablet: release information for the manga whose 신간 알림 is on.
 * 한국 정발 lists each work's Kakao volumes beyond the owned count (released or pre-registered);
 * 일본 shows the latest MangaDex volume and how far it is ahead of the Korean edition. Unread
 * events only highlight what they concern (NEW); 확인 marks them read and the information stays.
 * The PC keeps its own update check and provider status here.
 */
export function CollectionReleases({ provider, collections, data, loading, error, query = "", coverUrl, onOpen, onChanged, onProviderChange }: Props) {
  const { gateway } = useLibrary();
  const api = gateway.collectionTracking;
  const { privacyMode } = usePrivacy();
  const { restricted, hidden } = useWorkloadProfile();
  const [status, setStatus] = useState<CollectionUpdateStatus | null>(null);
  const [working, setWorking] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [confirmAll, setConfirmAll] = useState(false);
  const generation = useRef(0);
  const region = provider === "mangadex" ? "jp" : "kr";

  // Only the provider's update progress is polled here; the release data itself is shared and
  // re-read when the Collection list changes (see releaseData.ts).
  useEffect(() => {
    if (hidden || !api?.updateStatus) return;
    const current = ++generation.current;
    setStatus(null);
    const load = () => void api.updateStatus?.(provider).then(next => { if (generation.current === current) setStatus(next ?? null); }, () => undefined);
    load();
    const timer = setInterval(load, restricted ? 60_000 : 5_000);
    return () => { generation.current++; clearInterval(timer); };
  }, [api, provider, restricted, hidden]);

  const today = localDay();
  const matchesQuery = createKoreanMatcher(query);
  const works = collections.filter(work => work.type === "manga" && matchesQuery(work.name));
  const board = data?.board ?? new Map();
  const inbox = data?.inbox ?? [];
  const byWork = groupInbox(inbox);
  const korean = koreanReleases(works, board, byWork, today);
  const japan = japanReleases(works, board, byWork);
  const watched = works.filter(work => board.get(work.id)?.releaseWatch.enabled);
  const shown = new Set([...korean, ...japan].map(row => row.work.id));
  const news = { kr: korean.filter(row => row.volumes.some(volume => volume.fresh)).length, jp: japan.filter(row => row.aheadVolumes.some(volume => volume.fresh)).length };
  const others = [...groupInbox(inbox.filter(item => !shown.has(item.collectionId) && matchesQuery(item.collectionName))).entries()];
  const waiting = Boolean(status?.retryAt && Date.parse(status.retryAt) > Date.now());
  const busy = working !== null;
  const byId = new Map(collections.map(work => [work.id, work]));

  async function acknowledge(key: string, items: ReleaseInboxItem[]) {
    if (!api || busy || !items.length) return;
    setWorking(key); setMessage(null);
    try {
      // Exact event IDs from this snapshot, per work, so later events stay unread.
      const batches = new Map<string, string[]>();
      for (const item of items) batches.set(item.collectionId, [...(batches.get(item.collectionId) ?? []), item.event.id]);
      for (const [id, ids] of batches) {
        for (let offset = 0; offset < ids.length; offset += 2000) await api.acknowledge(id, ids.slice(offset, offset + 2000));
        const done = new Set(ids);
        updateCachedInbox(current => current.filter(item => !done.has(item.event.id)));
      }
      void Promise.resolve(onChanged()).catch(() => undefined);
    } catch (err) { setMessage(commandErrorMessage(err, "신간 알림을 확인 처리하지 못했습니다.")); }
    finally { setWorking(null); }
  }

  async function check() {
    if (!api?.runUpdates || busy || restricted) return;
    const current = generation.current;
    setWorking("check"); setMessage(null);
    try {
      // Continue small batches while this view remains open; the app's background loop uses the
      // same backend lock and resumes pending work independently.
      do {
        if (getWorkloadProfile().restricted) break;
        const result = await api.runUpdates(provider);
        if (generation.current !== current) return;
        setStatus(result);
        if (!result.busy) void Promise.resolve(onChanged()).catch(() => undefined);
        if (!result.busy && (!result.remaining || result.retryAt)) break;
        await new Promise(resolve => setTimeout(resolve, 1000));
      } while (generation.current === current);
    } catch (err) { setMessage(commandErrorMessage(err, "업데이트 확인에 실패했습니다.")); }
    finally { setWorking(null); }
  }

  const cover = (work: CollectionSummary | undefined) => {
    const url = work && !privacyMode ? coverUrl(work) : null;
    return <span className="collection-releases__cover">{url ? <img src={url} alt="" loading="lazy" decoding="async" draggable={false} /> : <span aria-hidden="true" />}</span>;
  };
  const confirm = (key: string, name: string, items: ReleaseInboxItem[]) => <Button size="sm" variant="ghost" className="collection-releases__confirm" disabled={busy} aria-label={`${name} 확인`} onClick={() => void acknowledge(key, items)}>{working === key ? "확인 중…" : "확인"}</Button>;
  const head = (id: string, name: string, lines: ReactNode, items: ReleaseInboxItem[]) => <div className="collection-releases__head">
    <button type="button" className="collection-releases__open" data-collection-id={id} onClick={() => onOpen(id)}>
      {cover(byId.get(id))}
      <span className="collection-releases__title"><strong>{name}</strong>{lines}</span>
      {items.length > 0 && <span className="collection-releases__new" aria-label={`새 알림 ${items.length}개`}>NEW {items.length}</span>}
    </button>
    {items.length > 0 && confirm(id, name, items)}
  </div>;

  return <section className="collection-releases" aria-label="신간">
    <div className="collection-releases__bar">
      <div className="collection-releases__segments" role="tablist" aria-label="신간 지역">
        {(["kakao", "mangadex"] as const).map(value => {
          const key = value === "kakao" ? "kr" : "jp";
          return <button key={value} type="button" role="tab" className="collection-releases__segment" aria-selected={provider === value}
            aria-description={news[key] ? `새 소식 ${news[key]}개` : undefined} onClick={() => { if (value !== provider) onProviderChange(value); }}>
            {value === "kakao" ? "한국 정발" : "일본"}{news[key] > 0 && <span className="collection-releases__count" aria-hidden="true">{news[key]}</span>}
          </button>;
        })}
      </div>
      <div className="collection-releases__actions">
        {inbox.length > 0 && <span className="collection-releases__unread">새 알림 {inbox.length.toLocaleString()}개</span>}
        {api?.runUpdates && <Button size="sm" disabled={busy || waiting || restricted} onClick={() => void check()}>{working === "check" ? "처리 중…" : waiting ? "재시도 대기" : "업데이트 확인"}</Button>}
        <Button size="sm" disabled={busy || inbox.length === 0} onClick={() => setConfirmAll(true)}>모두 확인</Button>
      </div>
    </div>
    {status && (status.checked > 0 || status.remaining > 0 || status.stopReason || status.lastFailure) && <div className="collection-releases__status" role="status">
      <span>{provider === "mangadex" ? "MangaDex" : "Kakao"} 확인 {status.checked}개 · 남음 {status.remaining}개{status.failed > 0 ? ` · 실패 ${status.failed}회` : ""}{status.finishedAt ? ` · 완료 ${new Date(status.finishedAt).toLocaleString("ko-KR")}` : ""}</span>
      {status.lastFailure && <span>{failureDescription(status.lastFailure)} <Button size="sm" variant="ghost" onClick={() => onOpen(status.lastFailure!.collectionId)}>실패한 작품 보기</Button></span>}
      {status.stopReason && <span>{!status.lastFailure || status.stopReason === "credential_not_configured" || status.stopReason === "invalid_credential" ? STOP_REASON[status.stopReason] : "업데이트가 잠시 중단됐습니다."}{status.retryAt ? ` 앱 실행 중 ${new Date(status.retryAt).toLocaleString("ko-KR")}부터 자동 재시도합니다.` : ""}</span>}
    </div>}
    {message && <p className="collection-releases__error" role="alert">{message}</p>}
    {Boolean(error) && !data && <p className="collection-releases__error" role="alert">{commandErrorMessage(error, "신간 정보를 불러오지 못했습니다.")}</p>}
    <div className="collection-releases__body">
      {!data && loading && <p className="collection-releases__hint" role="status">신간 정보를 불러오는 중…</p>}
      {data && !watched.length && !others.length && <EmptyState title="신간 알림을 켠 만화가 없습니다."><p>작품의 보유 권수 옆에서 신간 알림을 켜면 여기에 모입니다.</p></EmptyState>}
      {data && watched.length > 0 && region === "kr" && !korean.length && <EmptyState title="소장하지 않은 정발 권이 없습니다."><p>한국에 나온 권을 모두 소장했거나 아직 발매 정보가 없습니다.</p></EmptyState>}
      {data && watched.length > 0 && region === "jp" && !japan.length && <EmptyState title="일본 발매 정보가 없습니다."><p>MangaDex에서 찾은 권이 있으면 여기에 표시됩니다.</p></EmptyState>}

      {region === "kr" && korean.map(row => <section key={row.work.id} className={`collection-releases__group${row.fresh ? " is-new" : ""}`} aria-label={row.work.name}>
        {head(row.work.id, row.work.name, <small>{row.owned === null ? "소장 기록 없음" : `${row.owned}권까지 소장`}</small>, byWork.get(row.work.id) ?? [])}
        <ul className="collection-releases__volumes">{row.volumes.map(volume => <li key={volume.volumeNumber} className={volume.fresh ? "is-new" : undefined}>
          <span className={volume.upcoming ? "is-upcoming" : undefined}>{koreanVolumeLine(volume, today)}</span>
          <span className="collection-releases__tag">미보유</span>
          {volume.fresh && <span className="collection-releases__new">NEW</span>}
        </li>)}</ul>
      </section>)}

      {region === "jp" && japan.map(row => <section key={row.work.id} className={`collection-releases__group${row.fresh ? " is-new" : ""}`} aria-label={row.work.name}>
        {head(row.work.id, row.work.name, <><small>일본 최신 {row.latest}권</small>{row.ahead ? <small className="is-ahead">한국 정발보다 {row.ahead}권 앞섬</small> : null}</>, byWork.get(row.work.id) ?? [])}
        {row.aheadVolumes.length > 0 && <ul className="collection-releases__chips" aria-label={`${row.work.name} 일본 권`}>
          {row.aheadVolumes.slice(0, AHEAD_CHIPS).map(volume => <li key={volume.volumeNumber} className={volume.fresh ? "is-new" : undefined}><span>{volume.volumeNumber}권</span>{volume.fresh && <span className="collection-releases__new">NEW</span>}</li>)}
          {row.aheadVolumes.length > AHEAD_CHIPS && <li className="is-more"><span>외 {row.aheadVolumes.length - AHEAD_CHIPS}권</span></li>}
        </ul>}
      </section>)}

      {data && others.length > 0 && <>
        <h3 className="collection-releases__others">{shown.size ? "그 밖의 새 알림" : "새 알림"}</h3>
        {others.map(([id, items]) => <section key={id} className="collection-releases__group is-new" aria-label={items[0]!.collectionName}>
          {head(id, items[0]!.collectionName, null, items)}
          <ul className="collection-releases__volumes">{items.map(item => <li key={item.event.id}><span>{releaseLine(item)}</span></li>)}</ul>
        </section>)}
      </>}
    </div>
    {confirmAll && <Dialog open title="모두 확인할까요?" onClose={() => setConfirmAll(false)}>
      <div className="collection-releases__dialog">
        <p>새 알림 {inbox.length.toLocaleString()}개를 읽음으로 바꿉니다. 발매 정보는 그대로 남습니다.</p>
        <div className="ui-dialog__actions">
          <Button onClick={() => setConfirmAll(false)}>취소</Button>
          <Button variant="primary" onClick={() => { setConfirmAll(false); void acknowledge("all", inbox); }}>모두 확인</Button>
        </div>
      </div>
    </Dialog>}
  </section>;
}
