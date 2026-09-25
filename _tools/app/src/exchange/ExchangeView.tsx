import { useEffect, useRef, useState } from "react";
import { ViewToolbar } from "../layout/ViewToolbar";
import { Button } from "../shared/ui/Button";
import { formatBytes } from "../assets/assetMetadata";
import { commandErrorMessage } from "../library/errorMessage";
import { subscribeToTauriDrops, type DropSubscriber } from "../ingestion/useFileDrop";
import { exchangeStore, useExchangeSnapshot, type ExchangeIncoming, type ExchangeOutgoing, type ExchangeReceived, type ExchangeStore } from "./exchangeStore";
import "./exchange.css";

export type FilePicker = () => Promise<string[] | null>;

const pickWithDialog = (directory: boolean): FilePicker => async () => {
  const { open } = await import("@tauri-apps/plugin-dialog");
  const picked = await open({ multiple: !directory, directory, title: directory ? "보낼 폴더" : "보낼 파일" });
  return picked ? (Array.isArray(picked) ? picked : [picked]) : null;
};

const percent = (done: number, total: number) => (total > 0 ? Math.min(100, Math.floor((done / total) * 100)) : 100);

/** The row's state line: 업로드 중 → 대기 중 (받으면 삭제됨) → 전달됨, or a failure. */
export function outgoingLabel(row: ExchangeOutgoing): string {
  switch (row.state) {
    case "queued": return row.message ?? "보낼 차례를 기다리는 중";
    case "zipping": return `압축 중 ${percent(row.done, row.sizeBytes)}%`;
    case "hashing": return `파일 확인 중 ${percent(row.done, row.sizeBytes)}%`;
    case "uploading": return `업로드 중 ${percent(row.done, row.sizeBytes)}%`;
    case "waiting": return "대기 중 (받으면 삭제됨)";
    case "delivered": return "전달됨";
    case "expired": return "만료됨 (받지 않음)";
    case "cancelled": return row.message ? `취소됨 · ${row.message}` : "취소됨";
    case "interrupted": return row.message ?? "중단됨";
    case "failed": return row.message ? `실패 · ${row.message}` : "실패";
  }
}

function Progress({ done, total, label }: { done: number; total: number; label: string }) {
  return <div className="exchange-progress" role="progressbar" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent(done, total)}><span style={{ width: `${percent(done, total)}%` }} /></div>;
}

function OutgoingRow({ row, store, onError }: { row: ExchangeOutgoing; store: ExchangeStore; onError: (message: string) => void }) {
  const run = (action: Promise<unknown>) => void action.catch((error) => onError(commandErrorMessage(error, "요청을 처리하지 못했습니다.")));
  const active = row.state === "uploading" || row.state === "hashing" || row.state === "zipping";
  return <li className={`exchange-row is-${row.state}`}>
    <div className="exchange-row-main">
      <span className="exchange-name" title={row.fileName}>{row.fileName}</span>
      <span className="exchange-meta">{formatBytes(row.sizeBytes)}{row.toName ? ` · ${row.toName}` : ""}{row.note ? ` · ${row.note}` : ""}</span>
    </div>
    <div className="exchange-row-state">
      <span className="exchange-state" role="status">{outgoingLabel(row)}</span>
      {active && <Progress done={row.done} total={row.sizeBytes} label={`${row.fileName} 진행률`} />}
    </div>
    <div className="exchange-row-actions">
      {row.retryable && <Button size="sm" onClick={() => run(store.retry(row.transferId))}>재시도</Button>}
      {row.cancellable && <Button size="sm" variant="ghost" onClick={() => run(store.cancel(row.transferId))}>{row.state === "failed" ? "지우기" : "취소"}</Button>}
    </div>
  </li>;
}

function IncomingRow({ row, store, onError }: { row: ExchangeIncoming; store: ExchangeStore; onError: (message: string) => void }) {
  const run = (action: Promise<unknown>) => void action.catch((error) => onError(commandErrorMessage(error, "요청을 처리하지 못했습니다.")));
  return <li className={`exchange-row is-${row.state}`}>
    <div className="exchange-row-main">
      <span className="exchange-name" title={row.fileName}>{row.fileName}</span>
      <span className="exchange-meta">{formatBytes(row.sizeBytes)}{row.fromName ? ` · ${row.fromName}` : ""}</span>
    </div>
    <div className="exchange-row-state">
      <span className="exchange-state" role="status">{row.state === "failed" ? `실패 · ${row.message ?? "받지 못함"}` : `받는 중 ${percent(row.done, row.sizeBytes)}%`}</span>
      {row.state === "downloading" && <Progress done={row.done} total={row.sizeBytes} label={`${row.fileName} 진행률`} />}
    </div>
    <div className="exchange-row-actions">
      {row.state === "failed" && <>
        <Button size="sm" onClick={() => run(store.retry(row.transferId))}>재시도</Button>
        <Button size="sm" variant="ghost" onClick={() => run(store.cancel(row.transferId))}>받지 않기</Button>
      </>}
    </div>
  </li>;
}

function ReceivedRow({ row, store, onError }: { row: ExchangeReceived; store: ExchangeStore; onError: (message: string) => void }) {
  const run = (action: Promise<unknown>) => void action.catch((error) => onError(commandErrorMessage(error, "파일을 열지 못했습니다.")));
  const at = new Date(row.receivedAt);
  return <li className="exchange-row is-received">
    <div className="exchange-row-main">
      <span className="exchange-name" title={row.fileName}>{row.fileName}</span>
      <span className="exchange-meta">{formatBytes(row.sizeBytes)}{row.fromName ? ` · ${row.fromName}` : ""} · <time dateTime={row.receivedAt}>{Number.isNaN(at.getTime()) ? row.receivedAt : at.toLocaleString("ko-KR", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}</time></span>
    </div>
    <div className="exchange-row-state"><span className="exchange-state">{row.exists ? "다운로드 폴더에 저장됨" : "옮겨졌거나 삭제됨"}</span></div>
    <div className="exchange-row-actions">
      <Button size="sm" disabled={!row.exists} onClick={() => run(store.open(row.transferId))}>열기</Button>
      <Button size="sm" variant="ghost" disabled={!row.exists} onClick={() => run(store.reveal(row.transferId))}>폴더에서 보기</Button>
    </div>
  </li>;
}

function TokenForm({ store, configured, onError }: { store: ExchangeStore; configured: boolean; onError: (message: string) => void }) {
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  async function save(value: string | null) {
    setBusy(true);
    try { await store.setToken(value); setToken(""); } catch (error) { onError(commandErrorMessage(error, "토큰을 저장하지 못했습니다.")); } finally { setBusy(false); }
  }
  return <form className="exchange-token" onSubmit={(event) => { event.preventDefault(); if (token.trim()) void save(token); }}>
    <label htmlFor="exchange-token">이 PC 전용 토큰</label>
    <input id="exchange-token" className="ui-input" type="password" autoComplete="off" spellCheck={false} value={token} onChange={(event) => setToken(event.target.value)} placeholder="서버에서 이 PC용으로 발급한 토큰" />
    <div className="exchange-token-actions">
      <Button type="submit" variant="primary" size="sm" disabled={busy || !token.trim()}>저장</Button>
      {configured && <Button type="button" variant="ghost" size="sm" disabled={busy} onClick={() => void save(null)}>토큰 지우기</Button>}
    </div>
  </form>;
}

export function ExchangeView({ store = exchangeStore, pickFiles = pickWithDialog(false), pickFolder = pickWithDialog(true), subscribeDrops = subscribeToTauriDrops }: { store?: ExchangeStore; pickFiles?: FilePicker; pickFolder?: FilePicker; subscribeDrops?: DropSubscriber }) {
  const snapshot = useExchangeSnapshot(store);
  const [target, setTarget] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [over, setOver] = useState(false);
  const { availability, devices } = snapshot;
  const chosen = devices.find((device) => device.deviceId === target) ?? (devices.length === 1 ? devices[0] : null);

  // Opening the panel is how received files become "seen" (and leave the tray count).
  useEffect(() => { if (snapshot.unseen > 0) void store.markSeen().catch(() => undefined); }, [store, snapshot.unseen]);
  useEffect(() => { void store.refresh().catch(() => undefined); }, [store]);

  async function send(paths: string[]) {
    if (!paths.length) return;
    setError(null);
    try { await store.send(paths, chosen?.deviceId ?? null); } catch (reason) { setError(commandErrorMessage(reason, "파일을 보내지 못했습니다.")); }
  }
  const sendRef = useRef(send);
  useEffect(() => { sendRef.current = send; });
  useEffect(() => {
    let active = true;
    let stop: (() => void) | undefined;
    void subscribeDrops((event) => {
      if (!active) return;
      if (event.type === "enter" || event.type === "over") setOver(true);
      else if (event.type === "leave" || event.type === "cancel") setOver(false);
      else if (event.type === "drop") { setOver(false); void sendRef.current(event.paths); }
    }).then((unlisten) => { if (active) stop = unlisten; else unlisten(); }).catch(() => undefined);
    return () => { active = false; stop?.(); };
  }, [subscribeDrops]);

  async function choose(picker: FilePicker) {
    try { const paths = await picker(); if (paths) await send(paths); } catch (reason) { setError(commandErrorMessage(reason, "보낼 항목을 선택하지 못했습니다.")); }
  }

  const statusText = availability.state === "ready" ? (snapshot.selfName ? `이 PC · ${snapshot.selfName}` : "연결됨") : availability.state === "starting" ? "연결 중…" : availability.state === "offline" ? "서버에 연결할 수 없음 — 자동 재시도" : "사용할 수 없음";
  const navigation = <div className="exchange-index">
    <p className="exchange-index-label">받는 기기</p>
    {devices.length > 1
      ? <select className="exchange-target" aria-label="받는 기기" value={chosen?.deviceId ?? ""} onChange={(event) => setTarget(event.target.value || null)}>
          <option value="">선택해 주세요</option>
          {devices.map((device) => <option key={device.deviceId} value={device.deviceId}>{device.name}</option>)}
        </select>
      : <p className="exchange-index-value">{chosen?.name ?? "등록된 기기 없음"}</p>}
    <p className="exchange-index-label">받은 파일 저장 위치</p>
    <p className="exchange-index-value exchange-folder" title={snapshot.folder ?? undefined}>{snapshot.folder ?? "다운로드 폴더를 찾을 수 없음"}</p>
    <Button size="sm" variant="ghost" onClick={() => void store.openFolder().catch((reason) => setError(commandErrorMessage(reason, "폴더를 열지 못했습니다.")))}>폴더 열기</Button>
    {availability.state !== "unavailable" && <details className="exchange-token-details"><summary>이 PC 전용 토큰</summary><TokenForm store={store} configured={snapshot.tokenConfigured} onError={setError} /></details>}
  </div>;

  const receiving = snapshot.incoming.length + snapshot.received.length;
  return <div className={`exchange-workspace${over ? " is-drop-target" : ""}`}>
    <ViewToolbar title="보내기/받기" chrome={{ navigation, status: <span className="exchange-status" role="status">{statusText}</span> }} />
    {availability.state === "unavailable" && <div className="exchange-notice" role="alert">
      <p>{availability.message ?? "보내기/받기를 쓸 수 없습니다."}</p>
      {availability.needsToken && <TokenForm store={store} configured={snapshot.tokenConfigured} onError={setError} />}
    </div>}
    {error && <div className="exchange-error" role="alert"><span>{error}</span><Button size="sm" variant="ghost" onClick={() => setError(null)}>닫기</Button></div>}
    <div className="exchange-body">
      <section className="exchange-section" aria-labelledby="exchange-send-heading">
        <header className="exchange-section-header">
          <h3 id="exchange-send-heading">보내기</h3>
          <div className="exchange-section-actions">
            <Button size="sm" disabled={!chosen} onClick={() => void choose(pickFolder)}>폴더 보내기</Button>
            <Button variant="primary" size="sm" disabled={!chosen} onClick={() => void choose(pickFiles)}>파일 보내기</Button>
          </div>
        </header>
        {snapshot.outgoing.length
          ? <ul className="exchange-list" aria-label="보낸 파일">{snapshot.outgoing.map((row) => <OutgoingRow key={row.transferId} row={row} store={store} onError={setError} />)}</ul>
          : <p className="exchange-empty">{chosen ? `파일이나 폴더를 이 화면에 끌어 놓으면 ${chosen.name}(으)로 보냅니다. 폴더는 zip 하나로 묶어 보냅니다.` : devices.length > 1 ? "받는 기기를 먼저 선택해 주세요." : "받을 기기가 없습니다. 태블릿에서 Lakomics를 열면 여기에 나타납니다."}</p>}
      </section>
      <section className="exchange-section" aria-labelledby="exchange-receive-heading">
        <header className="exchange-section-header"><h3 id="exchange-receive-heading">받은 파일</h3></header>
        {receiving
          ? <ul className="exchange-list" aria-label="받은 파일">
              {snapshot.incoming.map((row) => <IncomingRow key={row.transferId} row={row} store={store} onError={setError} />)}
              {snapshot.received.map((row) => <ReceivedRow key={row.transferId} row={row} store={store} onError={setError} />)}
            </ul>
          : <p className="exchange-empty">다른 기기에서 보낸 파일은 자동으로 다운로드 폴더의 Lakomics 폴더에 저장됩니다.</p>}
      </section>
    </div>
    {over && <div className="exchange-drop-hint" aria-hidden="true">놓으면 {chosen?.name ?? "받는 기기"}(으)로 보냅니다</div>}
  </div>;
}
