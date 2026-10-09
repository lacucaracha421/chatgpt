import { ArrowPathIcon, ChevronDownIcon, ChevronUpIcon, ClockIcon, ExclamationTriangleIcon, MagnifyingGlassIcon, XMarkIcon } from "@heroicons/react/24/outline";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { CollectionSummary } from "../library/types";
import { Button } from "../shared/ui/Button";
import { displayTime } from "../shared/displayDate";
import { avLinkClient, type AvLinkInboxItem } from "./avLinkClient";
import { AvLinkChooserDialog } from "./AvLinkChooserDialog";
import "./avLink.css";

export type AvLinkApi = typeof avLinkClient;

const activeStatus = (item: AvLinkInboxItem) => item.status === "queued" || item.status === "fetching";
/** The choice is being written to the server; nothing else can be done with the row meanwhile. */
const applying = (item: AvLinkInboxItem) => item.applyState === "applying";
const stopped = (item: AvLinkInboxItem) => item.applyState === "blocked";

export function useAvLinkInbox({ enabled = true, poll = false, refreshKey = "", api = avLinkClient }: {
  enabled?: boolean;
  poll?: boolean;
  refreshKey?: string;
  api?: AvLinkApi;
}) {
  const [items, setItems] = useState<AvLinkInboxItem[]>([]);
  const [loading, setLoading] = useState(enabled);
  const [error, setError] = useState<string | null>(null);
  const refresh = useCallback(async () => {
    if (!enabled) return;
    try {
      const next = await api.listInbox();
      // An unchanged inbox keeps its array, so a re-read (every type switch) does not re-render the list.
      setItems(current => { const value = Array.isArray(next) ? next : []; return JSON.stringify(value) === JSON.stringify(current) ? current : value; });
      setError(null);
    } catch (reason) {
      setError(errorMessage(reason, "받은 품번을 불러오지 못했습니다."));
    } finally {
      setLoading(false);
    }
  }, [api, enabled]);

  useEffect(() => {
    if (!enabled) { setItems([]); setLoading(false); return; }
    void refresh();
  }, [enabled, refresh, refreshKey]);

  useEffect(() => {
    if (!enabled) return;
    const visibleRefresh = () => { if (document.visibilityState !== "hidden") void refresh(); };
    window.addEventListener("focus", visibleRefresh);
    document.addEventListener("visibilitychange", visibleRefresh);
    return () => {
      window.removeEventListener("focus", visibleRefresh);
      document.removeEventListener("visibilitychange", visibleRefresh);
    };
  }, [enabled, refresh]);

  const hasActive = items.some(item => activeStatus(item) || applying(item));
  useEffect(() => {
    if (!enabled || !poll || !hasActive) return;
    const timer = window.setInterval(() => { if (document.visibilityState !== "hidden") void refresh(); }, 5_000);
    return () => window.clearInterval(timer);
  }, [enabled, hasActive, poll, refresh]);

  return { items, loading, error, refresh };
}

export function useAvLinkPendingCount({ enabled = true, refreshVersion = 0, api = avLinkClient }: {
  enabled?: boolean;
  refreshVersion?: number;
  api?: AvLinkApi;
}) {
  const [count, setCount] = useState<number | null>(null);
  useEffect(() => {
    if (!enabled) return;
    let live = true;
    let request = 0;
    const refresh = async () => {
      const version = ++request;
      try {
        const next = await api.pendingCount();
        if (live && version === request) setCount(next);
      } catch { if (live && version === request) setCount(value => value ?? 0); }
    };
    void refresh();
    const visibleRefresh = () => { if (document.visibilityState !== "hidden") void refresh(); };
    window.addEventListener("focus", visibleRefresh);
    document.addEventListener("visibilitychange", visibleRefresh);
    return () => {
      live = false;
      window.removeEventListener("focus", visibleRefresh);
      document.removeEventListener("visibilitychange", visibleRefresh);
    };
  }, [api, enabled, refreshVersion]);
  return enabled ? count : 0;
}

export function AvLinkInbox({ items, collections, api = avLinkClient, error, onRefresh, onCollectionsChanged }: {
  items: AvLinkInboxItem[];
  collections: CollectionSummary[];
  api?: AvLinkApi;
  error?: string | null;
  onRefresh(): Promise<void>;
  onCollectionsChanged(): Promise<void>;
}) {
  const [expanded, setExpanded] = useState(true);
  const [chooserId, setChooserId] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [code, setCode] = useState("");
  const [busyId, setBusyId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const found = useMemo(() => items.filter(item => item.status === "found" && !applying(item) && !stopped(item)), [items]);
  if (items.length === 0) return null;

  async function action(id: string, work: () => Promise<unknown>) {
    setBusyId(id); setActionError(null);
    try { await work(); await onRefresh(); }
    catch (reason) { setActionError(errorMessage(reason, "요청을 처리하지 못했습니다.")); }
    finally { setBusyId(null); }
  }
  function beginFix(item: AvLinkInboxItem) { setEditingId(item.id); setCode(item.productCode); setActionError(null); }
  function saveCode(item: AvLinkInboxItem) {
    const next = code.trim();
    if (!next) { setActionError("품번을 입력해 주세요."); return; }
    void action(item.id, async () => { await api.fixCode(item.id, next); setEditingId(null); });
  }
  function dismiss(item: AvLinkInboxItem) {
    if (item.status === "found" && !window.confirm("가져온 후보를 버릴까요? 이 작업은 되돌릴 수 없습니다.")) return;
    void action(item.id, () => api.dismiss(item.id));
  }

  return <section className="av-link-inbox" aria-label="받은 품번">
    <div className="av-link-inbox__header">
      <h3>받은 품번</h3><span className="av-link-inbox__count numeric">{items.length.toLocaleString()}</span>
      <span className="av-link-inbox__hint">Chrome에서 보낸 품번 · 적용 전</span>
      <span className="av-link-inbox__spacer" />
      {found.length > 0 && <Button size="sm" variant="ghost" onClick={() => setChooserId(found[0].id)}>찾은 것 차례로 보기</Button>}
      <Button size="icon" variant="ghost" aria-label={expanded ? "받은 품번 접기" : "받은 품번 펼치기"} aria-expanded={expanded} onClick={() => setExpanded(value => !value)}>
        {expanded ? <ChevronUpIcon aria-hidden="true" /> : <ChevronDownIcon aria-hidden="true" />}
      </Button>
    </div>
    {expanded && <div className="av-link-inbox__rows">
      {items.map(item => <div className="av-link-row" key={item.id} data-status={item.status}>
        <span className="av-link-row__state-icon" aria-hidden="true">{statusIcon(item)}</span>
        <span className="av-link-row__identity">
          {editingId === item.id ? <span className="av-link-row__edit">
            <label><span>품번</span><input autoFocus maxLength={40} value={code} onChange={event => setCode(event.target.value)} onKeyDown={event => {
              if (event.key === "Enter") { event.preventDefault(); saveCode(item); }
              if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); setEditingId(null); }
            }} /></label>
            <Button size="sm" disabled={busyId === item.id} onClick={() => saveCode(item)}>저장</Button>
            <Button size="sm" variant="ghost" disabled={busyId === item.id} onClick={() => setEditingId(null)}>취소</Button>
          </span> : <><b className="av-link-code">{item.productCode}</b><small><span className="numeric">{receivedTime(item.receivedAt)}</span> Chrome에서</small></>}
        </span>
        <span className="av-link-row__status">{statusLabel(item)}</span>
        <span className="av-link-row__target">{targetCopy(item)}</span>
        <span className="av-link-row__actions">
          {item.status === "found" && !applying(item) && !stopped(item) && <Button size="sm" onClick={() => setChooserId(item.id)}>후보 보기</Button>}
          {(item.status === "not_found" || item.status === "error") && <>
            <Button size="sm" disabled={busyId === item.id} onClick={() => void action(item.id, () => api.retry(item.id))}><ArrowPathIcon aria-hidden="true" />다시 시도</Button>
            <Button size="sm" variant="ghost" disabled={busyId === item.id} onClick={() => beginFix(item)}>품번 고치기</Button>
          </>}
        </span>
        <Button size="icon" variant="ghost" aria-label={`${item.productCode} 버리기`} disabled={busyId === item.id || applying(item) || stopped(item)} onClick={() => dismiss(item)}><XMarkIcon aria-hidden="true" /></Button>
      </div>)}
    </div>}
    {(error || actionError) && <p className="av-link-inbox__error" role="alert">{actionError ?? error}</p>}
    {chooserId && <AvLinkChooserDialog inboxId={chooserId} collections={collections.filter(collection => collection.type === "av")} api={api}
      onClose={() => setChooserId(null)} onDismissed={async () => { setChooserId(null); await onRefresh(); }}
      onApplied={async () => { setChooserId(null); await Promise.all([onRefresh(), onCollectionsChanged()]); }} />}
  </section>;
}

function statusIcon(item: AvLinkInboxItem) {
  if (activeStatus(item) || applying(item)) return <ClockIcon />;
  if (item.status === "found") return <MagnifyingGlassIcon />;
  return <ExclamationTriangleIcon />;
}

function statusLabel(item: AvLinkInboxItem) {
  if (applying(item)) return <><span className="av-link-spinner" aria-hidden="true" />보내는 중</>;
  if (stopped(item)) return "멈춤";
  if (activeStatus(item)) return <><span className="av-link-spinner" aria-hidden="true" />찾는 중</>;
  if (item.status === "found") return "후보 있음";
  if (item.status === "not_found") return "못 찾음";
  return "오류";
}

function targetCopy(item: AvLinkInboxItem) {
  if (applying(item)) return <><b>컬렉션에 적용하는 중</b><small>서버에 반영되면 목록에서 사라져요</small></>;
  if (stopped(item)) return <><b>적용이 멈췄어요</b><small>다른 기기의 변경과 충돌했어요 · 상태 창의 “서버에서 막힌 변경”을 확인해 주세요</small></>;
  if (activeStatus(item)) return <><b>LibreDMM에서 찾는 중</b><small>정보와 재킷을 가져오고 있어요</small></>;
  if (item.status === "not_found") return <><b>LibreDMM에 없는 품번</b><small>품번 표기가 다르거나 아직 등록 전일 수 있어요</small></>;
  if (item.status === "error") return <><b>가져오지 못했습니다</b><small>{item.lastError || "잠시 뒤 다시 시도해 주세요"}</small></>;
  if (item.applyState === "failed") return <><b>지난 적용이 거절됐어요</b><small>후보를 다시 열어 확인해 주세요</small></>;
  if (item.collectionId) return <><b>기존 컬렉션에 후보 추가</b><small>→ {item.collectionName || "이름 없는 AV 컬렉션"}</small></>;
  if (item.matches && item.matches.length > 1) return <><b>같은 품번의 컬렉션이 {item.matches.length}개 있어요</b><small>후보를 열어 어디에 넣을지 고르세요</small></>;
  return <><b>새 AV 컬렉션 만들기</b><small>맞는 기존 컬렉션이 없습니다</small></>;
}

function receivedTime(value: string) {
  return displayTime(value) || "--:--";
}

export function errorMessage(reason: unknown, fallback: string) {
  if (reason instanceof Error) return reason.message.trim() || fallback;
  if (typeof reason === "object" && reason && "message" in reason && typeof reason.message === "string") return reason.message.trim() || fallback;
  return typeof reason === "string" && reason.trim() ? reason.trim() : fallback;
}
