import { useEffect, useRef, useState } from "react";
import { useLibrary } from "../library/LibraryContext";
import type { CollectionUpdateFailure, CollectionUpdateProvider, CollectionUpdateStatus, ReleaseInboxItem } from "../library/types";
import { commandErrorMessage } from "../library/errorMessage";
import { Button } from "../shared/ui/Button";
import { EmptyState } from "../shared/ui/EmptyState";
import { VirtualCoverGrid } from "./physical/VirtualCoverGrid";
import "./releaseInbox.css";

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
  provider: CollectionUpdateProvider;
  onOpen: (collectionId: string) => void;
  onChanged: () => void | Promise<void>;
  query?: string;
  revision?: unknown;
};

export function ReleaseInbox({ provider, onOpen, onChanged, query = "", revision }: Props) {
  const { gateway } = useLibrary();
  const api = gateway.collectionTracking;
  const [items, setItems] = useState<ReleaseInboxItem[] | null>(null);
  const [status, setStatus] = useState<CollectionUpdateStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const generation = useRef(0);
  const label = provider === "mangadex" ? "MangaDex" : "Kakao";
  const waiting = Boolean(status?.retryAt && Date.parse(status.retryAt) > Date.now());
  useEffect(() => {
    const current = ++generation.current;
    let loading = false;
    setItems(null); setStatus(null); setError(null); setBusy(false);
    const load = async () => {
      if (!api || loading) return;
      loading = true;
      try {
        const [next, progress] = await Promise.all([api.listInbox(), api.updateStatus?.(provider)]);
        if (generation.current !== current) return;
        setItems(next); setStatus(progress ?? null);
      } catch (err) {
        if (generation.current === current) setError(commandErrorMessage(err, "알림을 불러오지 못했습니다."));
      } finally { loading = false; }
    };
    void load();
    const timer = setInterval(() => void load(), 5_000);
    return () => { generation.current++; clearInterval(timer); };
  }, [api, provider]);
  useEffect(() => {
    let active = true;
    if (api) void api.listInbox().then(next => { if (active) setItems(next); }).catch(() => undefined);
    return () => { active = false; };
  }, [api, revision]);

  const providerItems = items?.filter(item => (item.provider === "mangadex" ? "mangadex" : "kakao") === provider) ?? [];
  const groups = [...new Map(providerItems.map(item => [item.collectionId, item])).values()]
    .filter(item => item.collectionName.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()));

  async function acknowledgeAll() {
    if (!api || busy) return;
    const current = generation.current;
    setBusy(true); setError(null);
    try {
      // Group by work and use the exact event IDs from this snapshot. New events
      // arriving during confirmation are not accidentally acknowledged.
      const batches = new Map<string, string[]>();
      for (const item of providerItems) batches.set(item.collectionId, [...(batches.get(item.collectionId) ?? []), item.event.id]);
      for (const [id, ids] of batches) {
        for (let offset = 0; offset < ids.length; offset += 2000) await api.acknowledge(id, ids.slice(offset, offset + 2000));
      }
      if (generation.current !== current) return;
      setItems(await api.listInbox());
      void Promise.resolve(onChanged()).catch(() => undefined);
    } catch (err) { if (generation.current === current) setError(commandErrorMessage(err, "알림을 확인 처리하지 못했습니다.")); }
    finally { if (generation.current === current) setBusy(false); }
  }
  async function check() {
    if (!api?.runUpdates || busy) return;
    const current = generation.current;
    setBusy(true); setError(null);
    try {
      // Continue small batches while this view remains open. The app's background
      // loop uses the same backend lock and independently resumes pending work.
      do {
        const result = await api.runUpdates(provider);
        if (generation.current !== current) return;
        setStatus(result); setItems(await api.listInbox());
        if (!result.busy) void Promise.resolve(onChanged()).catch(() => undefined);
        if (!result.busy && (!result.remaining || result.retryAt)) break;
        await new Promise(resolve => setTimeout(resolve, 1000));
      } while (generation.current === current);
    } catch (err) { if (generation.current === current) setError(commandErrorMessage(err, "업데이트 확인에 실패했습니다.")); }
    finally { if (generation.current === current) setBusy(false); }
  }
  return <section className="release-inbox" aria-label={`${label} 알림`}>
    <div className="release-inbox__toolbar">
      <strong>{label} 알림 <span>{groups.length}개 작품</span></strong>
      <div>
        {api?.runUpdates && <Button size="sm" disabled={busy || waiting} onClick={() => void check()}>{busy ? "처리 중…" : waiting ? "재시도 대기" : "업데이트 확인"}</Button>}
        <Button size="sm" disabled={busy || providerItems.length === 0} onClick={() => void acknowledgeAll()}>모두 확인</Button>
      </div>
    </div>
    <p className="release-inbox__hint">{provider === "mangadex" ? "새 권이 등록된 작품입니다." : "권수를 직접 입력하고 신간 알림을 켠 작품의 새 출간 정보입니다."} 제목을 누르면 작품으로 이동합니다. 앱 실행 중 하루 간격으로 갱신합니다.</p>
    {status && <div className="release-inbox__progress" role="status">
      <span>확인 {status.checked}개 · 남음 {status.remaining}개{status.failed > 0 ? ` · 실패 ${status.failed}회` : ""}</span>
      {status.startedAt && <span>시작 {new Date(status.startedAt).toLocaleString("ko-KR")}{status.finishedAt ? ` · 완료 ${new Date(status.finishedAt).toLocaleString("ko-KR")}` : ""}</span>}
      <details><summary>요청 시간</summary>
        <p>요청 {status.requests}회 · 처리 {(status.elapsedMs / 1000).toFixed(1)}초 · 통신 {(status.networkMs / 1000).toFixed(1)}초 · 요청 간 대기 {(status.throttleMs / 1000).toFixed(1)}초</p>
        {status.checked > 0 && status.remaining > 0 && !status.retryAt && <p>남은 처리 약 {Math.ceil(status.elapsedMs / status.checked * status.remaining / 1000)}초 — 이번 실행의 평균 기준이며 페이지 수와 응답 속도에 따라 달라집니다.</p>}
      </details>
      {status.lastFailure && <span>{failureDescription(status.lastFailure)} <Button size="sm" variant="ghost" onClick={() => onOpen(status.lastFailure!.collectionId)}>실패한 작품 보기</Button></span>}
      {status.stopReason && <span>{!status.lastFailure || status.stopReason === "credential_not_configured" || status.stopReason === "invalid_credential" ? STOP_REASON[status.stopReason] : "업데이트가 잠시 중단됐습니다."}{status.retryAt ? ` 앱 실행 중 ${new Date(status.retryAt).toLocaleString("ko-KR")}부터 자동 재시도합니다.` : ""}</span>}
    </div>}
    {error && <p role="alert">{error}</p>}
    {items === null && !error && <p>알림 불러오는 중…</p>}
    {items && groups.length === 0 && <EmptyState title={query.trim() ? "검색에 맞는 알림이 없습니다." : "확인하지 않은 신간 알림이 없습니다."} />}
    {groups.length > 0 && <VirtualCoverGrid key={provider} textRows items={groups} itemKey={item => item.collectionId} label={`${label} 알림 작품 목록`} render={item =>
      <button type="button" className="release-inbox__title" data-collection-id={item.collectionId} onClick={() => onOpen(item.collectionId)}>{item.collectionName}</button>
    } />}
  </section>;
}
