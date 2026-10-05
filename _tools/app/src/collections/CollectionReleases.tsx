import { useDelayedBusy } from "../shared/useDelayedBusy";
import { BusyLabel } from "../shared/ui/BusyLabel";
import { ArrowLeftIcon, ArrowPathIcon, BookOpenIcon } from "@heroicons/react/24/outline";
import { ViewToolbar } from "../layout/ViewToolbar";
import type { ViewChromeSpec } from "../layout/WorkspaceChrome";
import { displayCount, displayDate, displayDateTime } from "../shared/displayDate";
import { Skeleton } from "../shared/ui/Skeleton";
import { StableImage } from "../shared/ui/StableImage";
import { useEffect, useRef, useState } from "react";
import { getWorkloadProfile, useWorkloadProfile } from "../app/workloadProfile";
import { useLibrary } from "../library/LibraryContext";
import { commandErrorMessage } from "../library/errorMessage";
import type { CollectionSummary, CollectionUpdateFailure, CollectionUpdateProvider, CollectionUpdateStatus, ReleaseInboxItem } from "../library/types";
import { usePrivacy } from "../privacy/PrivacyContext";
import { Badge } from "../shared/ui/Badge";
import { Button } from "../shared/ui/Button";
import { Dialog } from "../shared/ui/Dialog";
import { EmptyState } from "../shared/ui/EmptyState";
import { SegmentedControl } from "../shared/ui/SegmentedControl";
import { groupInbox, localDay, releaseLine } from "./releaseCaption";
import { japanReleaseLedger, koreanReleaseLedger, releaseLedgerCounts, type ReleaseLedgerRow } from "./releaseLedger";
import { updateCachedInbox, type ReleaseData } from "./releaseData";
import "./collectionReleases.css";
import { createKoreanMatcher } from "../shared/koreanSearch";

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
  chrome?: ViewChromeSpec;
  onBack?: () => void;
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
export function CollectionReleases({ provider, chrome, onBack, collections, data, loading, error, query = "", coverUrl, onOpen, onChanged, onProviderChange }: Props) {
  const { gateway } = useLibrary();
  const api = gateway.collectionTracking;
  const { privacyMode } = usePrivacy();
  const { restricted, hidden } = useWorkloadProfile();
  const [status, setStatus] = useState<CollectionUpdateStatus | null>(null);
  const [working, setWorking] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [confirmAll, setConfirmAll] = useState(false);
  const generation = useRef(0);
  // Keep the entire last completed snapshot, including work names, during a shared re-read.
  const previous = useRef<{ data: ReleaseData; collections: CollectionSummary[] } | null>(null);
  if (data && !loading) previous.current = { data, collections };
  const snapshot = loading && previous.current ? previous.current : { data, collections };
  const shownData = snapshot.data;

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
  const works = snapshot.collections.filter(work => work.type === "manga" && matchesQuery(work.name));
  const board = shownData?.board ?? new Map();
  const inbox = shownData?.inbox ?? [];
  const byWork = groupInbox(inbox);
  const korean = koreanReleaseLedger(works, board, byWork, today);
  const japan = japanReleaseLedger(works, board, byWork, today);
  const watched = works.filter(work => board.get(work.id)?.releaseWatch.enabled);
  const shown = new Set([...korean, ...japan].map(row => row.work.id));
  const rows = provider === "mangadex" ? japan : korean;
  const counts = releaseLedgerCounts(rows);
  const checkedAt = status?.finishedAt ?? [...board.values()].map(entry => entry.releaseSchedule[provider]?.checkedAt).filter((value): value is string => !!value).sort().reverse()[0];
  const others = [...groupInbox(inbox.filter(item => !shown.has(item.collectionId) && matchesQuery(item.collectionName))).entries()];
  const waiting = Boolean(status?.retryAt && Date.parse(status.retryAt) > Date.now());
  const busy = working !== null;
  const byId = new Map(snapshot.collections.map(work => [work.id, work]));

  async function acknowledge(key: string, items: ReleaseInboxItem[]) {
    if (!api || busy || loading || !items.length) return;
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
    return <span className="collection-releases__cover">{url ? <StableImage src={url} alt="" loading="lazy" decoding="async" draggable={false} /> : <span aria-hidden="true" />}</span>;
  };
  const showChecking = useDelayedBusy(working === "check");
  const confirm = (key: string, name: string, items: ReleaseInboxItem[]) => <Button size="sm" variant="quiet" disabled={busy || loading} aria-label={`${name} 확인`} onClick={event => { event.stopPropagation(); void acknowledge(key, items); }}><BusyLabel busy={!!(working === key)} idle={"확인"}>확인 중…</BusyLabel></Button>;
  const renderRow = (row: ReleaseLedgerRow) => {
    const chips = row.chips.slice(0, 2);
    const fresh = row.chips.find(chip => chip.kind === "new");
    if (fresh && !chips.includes(fresh)) chips[1] = fresh;
    return <tr key={row.work.id} aria-label={row.work.name} onClick={() => { if (!loading) onOpen(row.work.id); }}>
    <td>{cover(row.work)}</td>
    <td className="collection-releases__name"><Button variant="quiet" size="sm" disabled={loading} data-collection-id={row.work.id} onClick={event => { event.stopPropagation(); onOpen(row.work.id); }}><strong className="collection-releases__work-title">{row.work.name}</strong></Button></td>
    <td className="collection-releases__owned">{row.owned === null ? "기록 없음" : row.owned === 0 ? "0권" : row.owned === 1 ? "1권" : `1–${displayCount(row.owned)} 권`}</td>
    <td><div className="collection-releases__chips" aria-label={`${row.work.name} ${provider === "mangadex" ? "일본" : "정발"} 권`}>
      {chips.map(chip => chip.kind === "upcoming"
        // Upcoming volumes are a dated ledger cell with a line cue; released volumes use shared badges.
        ? <span key={chip.volumeNumber} className="collection-releases__upcoming" data-chip-kind={chip.kind}><span>{chip.label}</span></span>
        : <Badge key={chip.volumeNumber} variant={chip.kind === "new" ? "accent" : "plain"} data-chip-kind={chip.kind}><span>{chip.label}</span></Badge>)}
      {row.chips.length > 2 && <Badge aria-label={`추가 ${row.chips.length - 2}권`}>+{row.chips.length - 2}</Badge>}
      {!row.chips.length && <span className="collection-releases__muted">—</span>}
    </div></td>
    <td className="collection-releases__date">{row.date ? displayDate(row.date) : "—"}</td>
    <td><div className="collection-releases__state"><div>
      {row.status === "NEW" ? <Badge variant="accent" aria-label={`새 알림 ${row.items.length}개`}>NEW</Badge> : <span className={row.status.startsWith("D-") || row.status === "오늘" ? "collection-releases__soon" : "collection-releases__muted"}>{row.status}</span>}
      {row.ahead && <small>{row.ahead}</small>}
    </div>{row.items.length > 0 && confirm(row.work.id, row.work.name, row.items)}</div></td>
  </tr>;
  };

  return <section className="collection-releases" aria-label="신간">
    <ViewToolbar title="신간" titleContent={<span className="collection-releases__heading">신간</span>} ariaLabel="컬렉션 도구" chrome={chrome}
      leadingAction={onBack ? <Button variant="ghost" size="icon" aria-label="컬렉션으로 돌아가기" onClick={onBack}><ArrowLeftIcon aria-hidden="true" /></Button> : undefined}
      titleAccessory={<><span className="collection-toolbar__count">{displayCount(rows.length + others.length)}</span><div className="collection-releases__actions">
        <SegmentedControl label="신간 지역" options={[{ value: "kakao", label: "한국 정발", count: korean.length }, { value: "mangadex", label: "일본", count: japan.length }]} value={provider} onChange={onProviderChange} />
        {checkedAt && <span className="collection-releases__checked">{displayDateTime(checkedAt)} 확인</span>}
        {api?.runUpdates && <Button size="sm" variant="quiet" aria-label={showChecking ? "처리 중…" : waiting ? "재시도 대기" : "새로고침"} aria-description={checkedAt ? `${displayDateTime(checkedAt)} 확인` : undefined} disabled={busy || waiting || restricted || loading} onClick={() => void check()}><ArrowPathIcon aria-hidden="true" /></Button>}
        <Button size="sm" variant="quiet" disabled={busy || loading || inbox.length === 0} onClick={() => setConfirmAll(true)}>모두 확인</Button>
      </div></>}
    />
    {status && (status.busy || status.remaining > 0 || status.stopReason || status.lastFailure) && <div className="collection-releases__status" role="status">
      <span>{provider === "mangadex" ? "MangaDex" : "Kakao"} 확인 {status.checked}개 · 남음 {status.remaining}개{status.failed > 0 ? ` · 실패 ${status.failed}회` : ""}{status.finishedAt ? ` · 완료 ${displayDateTime(status.finishedAt, new Date(), { withTime: true })}` : ""}</span>
      {status.lastFailure && <span>{failureDescription(status.lastFailure)} <Button size="sm" variant="ghost" onClick={() => onOpen(status.lastFailure!.collectionId)}>실패한 작품 보기</Button></span>}
      {status.stopReason && <span>{!status.lastFailure || status.stopReason === "credential_not_configured" || status.stopReason === "invalid_credential" ? STOP_REASON[status.stopReason] : "업데이트가 잠시 중단됐습니다."}{status.retryAt ? ` 앱 실행 중 ${displayDateTime(status.retryAt, new Date(), { withTime: true })}부터 자동 재시도합니다.` : ""}</span>}
    </div>}
    {message && <p className="collection-releases__error" role="alert">{message}</p>}
    {Boolean(error) && !data && <p className="collection-releases__error" role="alert">{commandErrorMessage(error, "신간 정보를 불러오지 못했습니다.")}</p>}
    <div className="collection-releases__body" inert={loading || undefined} aria-busy={loading}>
      {!shownData && loading && <Skeleton className="collection-releases__skeleton" label="신간 읽는 중" />}
      {shownData && <div className="collection-releases__counts" aria-label="권별 집계">
        <span><strong>{displayCount(counts.fresh)}</strong>새로 나옴</span>
        <span><strong>{displayCount(counts.unowned)}</strong>나왔지만 아직 없음</span>
        <span><strong>{displayCount(counts.upcoming)}</strong>발매 예정</span>
      </div>}
      {shownData && rows.length > 0 && <table className="collection-releases__ledger" aria-label={`${provider === "mangadex" ? "일본" : "한국 정발"} 신간`}>
        <colgroup><col className="collection-releases__cover-col" /><col className="collection-releases__title-col" /><col className="collection-releases__owned-col" /><col /><col className="collection-releases__date-col" /><col className="collection-releases__state-col" /></colgroup>
        <thead><tr><th aria-label="표지" /><th scope="col">작품</th><th scope="col">소장</th><th scope="col">안 가진 권</th><th scope="col">날짜</th><th scope="col">상태</th></tr></thead>
        <tbody>{rows.map(renderRow)}</tbody>
      </table>}
      {shownData && !loading && !watched.length && !others.length && <EmptyState icon={BookOpenIcon} title="신간 알림을 켠 만화가 없습니다." />}
      {shownData && !loading && watched.length > 0 && !rows.length && <EmptyState icon={BookOpenIcon} title={provider === "mangadex" ? "일본 발매 정보가 없습니다." : "소장하지 않은 정발 권이 없습니다."} />}
      {shownData && others.length > 0 && <>
        <h3 className="collection-releases__others">{shown.size ? "그 밖의 새 알림" : "새 알림"}</h3>
        {others.map(([id, items]) => <div key={id} className="collection-releases__other" role="region" aria-label={items[0]!.collectionName}>
          <Button variant="quiet" size="sm" disabled={loading} onClick={() => onOpen(id)}>{cover(byId.get(id))}{items[0]!.collectionName}</Button>
          <span>{items.map(releaseLine).join(" · ")}</span>
          <Badge variant="accent" aria-label={`새 알림 ${items.length}개`}>NEW</Badge>
          {confirm(id, items[0]!.collectionName, items)}
        </div>)}
      </>}
    </div>
    {confirmAll && <Dialog open title="모두 확인할까요?" onClose={() => setConfirmAll(false)}>
      <div className="collection-releases__dialog">
        <p>새 알림 {inbox.length.toLocaleString()}개를 읽음으로 바꿉니다. 발매 정보는 그대로 남습니다.</p>
        <div className="ui-dialog__actions">
          <Button onClick={() => setConfirmAll(false)}>취소</Button>
          <Button variant="primary" disabled={loading || busy} onClick={() => { setConfirmAll(false); void acknowledge("all", inbox); }}>모두 확인</Button>
        </div>
      </div>
    </Dialog>}
  </section>;
}
