import { Fragment, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { ArrowsUpDownIcon, CheckIcon, ComputerDesktopIcon, DevicePhoneMobileIcon, DeviceTabletIcon, ExclamationTriangleIcon, FolderIcon, PaperClipIcon } from "@heroicons/react/24/outline";
import { ViewToolbar } from "../layout/ViewToolbar";
import { Button } from "../shared/ui/Button";
import { formatBytes } from "../assets/assetMetadata";
import { commandErrorMessage } from "../library/errorMessage";
import { subscribeToTauriDrops, type DropSubscriber } from "../ingestion/useFileDrop";
import { exchangeStore, useExchangeSnapshot, type ExchangeDevice, type ExchangeIncoming, type ExchangeOutgoing, type ExchangeReceived, type ExchangeSnapshot, type ExchangeStore } from "./exchangeStore";
import { batchProgress, buildTimeline, clockLabel, dayKey, dayLabel, extensionLabel, isImageName, withParticle, type BatchPart, type TimelineBlock, type TimelineEntry } from "./timeline";
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

/** One timeline row: something this PC sent, something arriving, or a saved file. */
type Item =
  | { kind: "out"; row: ExchangeOutgoing }
  | { kind: "in"; row: ExchangeIncoming }
  | { kind: "saved"; row: ExchangeReceived };

const MOVING_OUT = new Set(["queued", "zipping", "hashing", "uploading"]);
const moving = (item: Item) => item.kind === "out" ? MOVING_OUT.has(item.row.state) : item.kind === "in" && item.row.state === "downloading";
const failed = (item: Item) => item.kind === "out" ? item.row.state === "failed" || item.row.state === "interrupted" : item.kind === "in" && item.row.state === "failed";

function part(item: Item): BatchPart {
  const size = Math.max(0, item.row.sizeBytes);
  if (item.kind === "saved") return { size, done: size, finished: true };
  if (item.kind === "in") return { size, done: item.row.state === "downloading" ? item.row.done : 0, finished: false };
  const finished = item.row.state === "waiting" || item.row.state === "delivered";
  return { size, done: finished ? size : item.row.state === "uploading" ? item.row.done : 0, finished };
}

function peerOf(item: Item): { id: string | null | undefined; name: string | null } {
  return item.kind === "out" ? { id: item.row.toDevice, name: item.row.toName } : { id: item.row.fromDevice, name: item.row.fromName };
}

/** Whether `item` was exchanged with `device`; rows whose device is gone follow the chosen one. */
function withDevice(item: Item, device: ExchangeDevice, devices: ExchangeDevice[]): boolean {
  const peer = peerOf(item);
  const matches = (candidate: ExchangeDevice) => peer.id ? peer.id === candidate.deviceId : !!peer.name && peer.name === candidate.name;
  return matches(device) || !devices.some(matches);
}

function items(snapshot: ExchangeSnapshot): Item[] {
  return [
    ...snapshot.outgoing.map((row): Item => ({ kind: "out", row })),
    ...snapshot.incoming.map((row): Item => ({ kind: "in", row })),
    ...snapshot.received.map((row): Item => ({ kind: "saved", row })),
  ];
}

export function timelineEntries(snapshot: ExchangeSnapshot, device: ExchangeDevice, receivedOnly: boolean): TimelineEntry<Item>[] {
  return items(snapshot)
    .filter((item) => (!receivedOnly || item.kind !== "out") && withDevice(item, device, snapshot.devices))
    .map((item) => ({
      row: item,
      transferId: item.row.transferId,
      batchId: item.row.batchId || item.row.transferId,
      mine: item.kind === "out",
      at: (item.kind === "saved" ? item.row.receivedAt : item.row.createdAt) ?? "",
    }));
}

/** Local thumbnails of sent and saved images for this session ("" = none). */
const thumbnails = new Map<string, Promise<string>>();
function useThumbnail(store: ExchangeStore, transferId: string, enabled: boolean): string {
  const [url, setUrl] = useState("");
  useEffect(() => {
    if (!enabled) return;
    let active = true;
    let request = thumbnails.get(transferId);
    if (!request) {
      request = store.thumbnail(transferId).then((bytes) => {
        const data = bytes instanceof ArrayBuffer ? bytes : new Uint8Array(bytes ?? []).buffer;
        if (!data.byteLength) { thumbnails.delete(transferId); return ""; }
        return URL.createObjectURL(new Blob([data], { type: "image/jpeg" }));
      }, () => "");
      thumbnails.set(transferId, request);
    }
    void request.then((value) => { if (active) setUrl(value); });
    return () => { active = false; };
  }, [store, transferId, enabled]);
  return enabled ? url : "";
}

/** Only files that exist on this PC have a thumbnail: never one still arriving. */
const hasLocalFile = (item: Item) => item.kind === "saved" ? item.row.exists : item.kind === "out" && item.row.state !== "zipping";

function Glyph({ item, store }: { item: Item; store: ExchangeStore }) {
  const url = useThumbnail(store, item.row.transferId, isImageName(item.row.fileName) && hasLocalFile(item));
  return url
    ? <span className="exchange-glyph is-image"><img src={url} alt="" /></span>
    : <span className={`exchange-glyph${/\.zip$/i.test(item.row.fileName) ? " is-zip" : ""}`} aria-hidden="true">{extensionLabel(item.row.fileName)}</span>;
}

function Progress({ done, total, label, striped }: { done: number; total: number; label: string; striped?: boolean }) {
  return <div className={`exchange-progress${striped ? " is-striped" : ""}`} role="progressbar" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent(done, total)}><span style={{ width: `${percent(done, total)}%` }} /></div>;
}

type RowProps = { item: Item; store: ExchangeStore; onError: (message: string) => void };

function FileRow({ item, store, onError }: RowProps) {
  const run = (action: Promise<unknown>, fallback = "요청을 처리하지 못했습니다.") => void action.catch((error) => onError(commandErrorMessage(error, fallback)));
  const { row } = item;
  const size = formatBytes(row.sizeBytes);
  let meta: string;
  let tone = "";
  let bar: { done: number; striped?: boolean } | null = null;
  let actions: ReactNode = null;
  if (item.kind === "out") {
    const out = item.row;
    meta = [size, outgoingLabel(out), out.note].filter(Boolean).join(" · ");
    tone = failed(item) ? "error" : out.state === "delivered" ? "done" : "";
    if (out.state === "uploading" || out.state === "hashing" || out.state === "zipping") bar = { done: out.done, striped: out.state === "zipping" };
    actions = <>
      {out.retryable && <Button size="sm" onClick={() => run(store.retry(out.transferId))}>재시도</Button>}
      {out.cancellable && <Button size="sm" variant="ghost" onClick={() => run(store.cancel(out.transferId))}>{out.state === "failed" ? "지우기" : "취소"}</Button>}
    </>;
  } else if (item.kind === "in") {
    const incoming = item.row;
    meta = incoming.state === "failed" ? `${size} · 실패 · ${incoming.message ?? "받지 못함"}` : `${formatBytes(incoming.done)} / ${size} · 받는 중 ${percent(incoming.done, incoming.sizeBytes)}%`;
    tone = incoming.state === "failed" ? "error" : "";
    if (incoming.state === "downloading") bar = { done: incoming.done };
    actions = <>
      {incoming.state === "failed" && <Button size="sm" onClick={() => run(store.retry(incoming.transferId))}>재시도</Button>}
      <Button size="sm" variant="ghost" onClick={() => run(store.cancel(incoming.transferId))}>받지 않기</Button>
    </>;
  } else {
    const saved = item.row;
    meta = `${saved.exists ? "저장됨" : "옮겨졌거나 삭제됨"} · ${size}`;
    tone = saved.exists ? "done" : "";
    actions = <>
      <Button size="sm" disabled={!saved.exists} onClick={() => run(store.open(saved.transferId), "파일을 열지 못했습니다.")}>열기</Button>
      <Button size="sm" variant="ghost" disabled={!saved.exists} onClick={() => run(store.reveal(saved.transferId), "폴더를 열지 못했습니다.")}>폴더에서 보기</Button>
    </>;
  }
  return <li className={`exchange-row is-${item.kind === "saved" ? "received" : item.row.state}`}>
    <Glyph item={item} store={store} />
    <div className="exchange-row-main">
      <span className="exchange-name" title={row.fileName}>{row.fileName}</span>
      <span className={`exchange-meta${tone ? ` is-${tone}` : ""}`} role="status">{tone === "error" && <ExclamationTriangleIcon aria-hidden="true" />}{meta}</span>
      {bar && <Progress done={bar.done} total={row.sizeBytes} label={`${row.fileName} 진행률`} striped={bar.striped} />}
    </div>
    <div className="exchange-row-actions">{actions}</div>
  </li>;
}

function ThumbStrip({ entries, store }: { entries: Item[]; store: ExchangeStore }) {
  const shown = entries.slice(0, 6);
  const more = entries.length - shown.length;
  return <div className="exchange-strip">
    {shown.map((item, index) => <StripTile key={item.row.transferId} item={item} store={store} more={index === shown.length - 1 ? more : 0} />)}
  </div>;
}

function StripTile({ item, store, more }: { item: Item; store: ExchangeStore; more: number }) {
  const url = useThumbnail(store, item.row.transferId, hasLocalFile(item));
  const { finished } = part(item);
  const active = moving(item);
  const label = more ? `${item.row.fileName} 외 ${more}개` : item.row.fileName;
  const tile = <>
    {url ? <img src={url} alt="" /> : <span className="exchange-strip-ext" aria-hidden="true">{extensionLabel(item.row.fileName)}</span>}
    {finished && <span className="exchange-strip-done" aria-hidden="true"><CheckIcon /></span>}
    {active && item.kind === "out" && item.row.state === "uploading" && <span className="exchange-strip-bar"><Progress done={item.row.done} total={item.row.sizeBytes} label={`${item.row.fileName} 진행률`} /></span>}
    {more > 0 && <span className="exchange-strip-more" aria-hidden="true">+{more}</span>}
  </>;
  return item.kind === "saved" && item.row.exists && !more
    ? <button type="button" className="exchange-strip-tile" aria-label={`${label} 열기`} onClick={() => void store.open(item.row.transferId).catch(() => undefined)}>{tile}</button>
    : <span className={`exchange-strip-tile${!finished && !active ? " is-waiting" : ""}`} role="img" aria-label={label}>{tile}</span>;
}

/** One send or arrival: a lone file, or a batch with its combined progress. */
function Block({ block, peerName, store, onError }: { block: TimelineBlock<Item>; peerName: string; store: ExchangeStore; onError: (message: string) => void }) {
  const entries = block.entries.map((entry) => entry.row);
  const progress = batchProgress(entries.map(part));
  const busy = entries.some(moving);
  const images = entries.length > 1 && entries.every((item) => isImageName(item.row.fileName));
  const delivered = block.mine && entries.every((item) => item.kind === "out" && item.row.state === "delivered");
  const time = clockLabel(block.at);
  const current = entries.find((item) => moving(item) && item.kind === "out" && item.row.state !== "queued") ?? entries.find(moving);
  const cancellable = entries.filter((item) => item.kind === "out" ? item.row.cancellable && item.row.state !== "failed" : item.kind === "in");
  // An arrival's own count is in the who line; a head is for sends and photo strips.
  const head = entries.length > 1 && (block.mine || images);
  return <li className={`exchange-block${block.mine ? " is-mine" : ""}`}>
    <p className="exchange-who">
      {block.mine ? "이 PC" : peerName}{time && <> · <time dateTime={block.at}>{time}</time></>}
      {!block.mine && entries.length > 1 && <> · 파일 <span className="numeric">{entries.length}</span>개</>}
      {delivered && <> · 전달됨<CheckIcon className="exchange-delivered" aria-hidden="true" /></>}
    </p>
    <div className={`exchange-bubble${entries.some(failed) ? " is-error" : ""}`}>
      {head && <div className="exchange-batch-head">
        <strong>{images ? "사진" : "파일"} <span className="numeric">{entries.length}</span>개</strong>
        <span className="exchange-batch-meta">{busy ? `${progress.finished}/${progress.total} · ${formatBytes(progress.done)} / ${formatBytes(progress.size)}` : formatBytes(progress.size)}</span>
        {busy && <span className="exchange-pct">{progress.percent}%</span>}
      </div>}
      {head && busy && <div className="exchange-batch-bar"><Progress done={progress.done} total={progress.size} label={`묶음 ${entries.length}개 진행률`} /></div>}
      {images
        ? <>
            <ThumbStrip entries={entries} store={store} />
            {entries.some(failed) && <ul className="exchange-list">{entries.filter(failed).map((item) => <FileRow key={item.row.transferId} item={item} store={store} onError={onError} />)}</ul>}
            {busy && <div className="exchange-batch-foot">
              <span>{current?.kind === "out" ? `${outgoingLabel(current.row)} · ${current.row.fileName}` : current ? `받는 중 · ${current.row.fileName}` : ""}</span>
              {cancellable.length > 1 && <Button size="sm" variant="ghost" onClick={() => cancellable.forEach((item) => void store.cancel(item.row.transferId).catch((error) => onError(commandErrorMessage(error, "요청을 처리하지 못했습니다."))))}>{block.mine ? "모두 취소" : "모두 받지 않기"}</Button>}
            </div>}
          </>
        : <ul className="exchange-list">{entries.map((item) => <FileRow key={item.row.transferId} item={item} store={store} onError={onError} />)}</ul>}
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

function DeviceIcon({ kind }: { kind: string }) {
  return kind === "pc" ? <ComputerDesktopIcon aria-hidden="true" /> : kind === "phone" ? <DevicePhoneMobileIcon aria-hidden="true" /> : <DeviceTabletIcon aria-hidden="true" />;
}

export function ExchangeView({ store = exchangeStore, pickFiles = pickWithDialog(false), pickFolder = pickWithDialog(true), subscribeDrops = subscribeToTauriDrops }: { store?: ExchangeStore; pickFiles?: FilePicker; pickFolder?: FilePicker; subscribeDrops?: DropSubscriber }) {
  const snapshot = useExchangeSnapshot(store);
  const [target, setTarget] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [dragging, setDragging] = useState<number | null>(null);
  const [receivedOnly, setReceivedOnly] = useState(false);
  const { availability, devices } = snapshot;
  const chosen = devices.find((device) => device.deviceId === target) ?? devices[0] ?? null;

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
      if (event.type === "enter") setDragging(event.paths.length);
      else if (event.type === "over") setDragging((count) => count ?? 0);
      else if (event.type === "leave" || event.type === "cancel") setDragging(null);
      else if (event.type === "drop") { setDragging(null); void sendRef.current(event.paths); }
    }).then((unlisten) => { if (active) stop = unlisten; else unlisten(); }).catch(() => undefined);
    return () => { active = false; stop?.(); };
  }, [subscribeDrops]);

  async function choose(picker: FilePicker) {
    try { const paths = await picker(); if (paths) await send(paths); } catch (reason) { setError(commandErrorMessage(reason, "보낼 항목을 선택하지 못했습니다.")); }
  }

  const blocks = chosen ? buildTimeline(timelineEntries(snapshot, chosen, receivedOnly)) : [];
  const scroller = useRef<HTMLDivElement>(null);
  const shown = useRef({ count: 0, device: "" });
  // Open at the newest end, and follow new blocks while the reader is already there.
  useLayoutEffect(() => {
    const element = scroller.current;
    const previous = shown.current;
    shown.current = { count: blocks.length, device: chosen?.deviceId ?? "" };
    if (!element || (blocks.length === previous.count && previous.device === shown.current.device)) return;
    const nearEnd = element.scrollHeight - element.scrollTop - element.clientHeight < 160;
    if (previous.count === 0 || previous.device !== shown.current.device || nearEnd) element.scrollTop = element.scrollHeight;
  });

  const all = items(snapshot);
  const statusText = availability.state === "ready" ? (snapshot.selfName ? `이 PC · ${snapshot.selfName}` : "연결됨") : availability.state === "starting" ? "연결 중…" : availability.state === "offline" ? "서버에 연결할 수 없음 — 자동 재시도" : "사용할 수 없음";
  const navigation = <div className="exchange-index">
    <div className="exchange-index-body">
      <span className="workspace-section-label">기기</span>
      {devices.length
        ? <div className="exchange-devices" role="group" aria-label="주고받을 기기">
            {devices.map((device) => {
              const active = all.filter((item) => moving(item) && withDevice(item, device, devices));
              const receiving = active.some((item) => item.kind === "in");
              const sending = active.some((item) => item.kind === "out");
              return <button key={device.deviceId} type="button" className="workspace-index-link exchange-device" aria-current={device.deviceId === chosen?.deviceId ? "page" : undefined} onClick={() => setTarget(device.deviceId)}>
                <DeviceIcon kind={device.kind} />
                <span className="exchange-device-text">{device.name}{(receiving || sending) && <small>{[receiving && "받는 중", sending && "보내는 중"].filter(Boolean).join(" · ")}</small>}</span>
                {active.length > 0 && <span className="exchange-device-count numeric">{active.length}</span>}
              </button>;
            })}
          </div>
        : <p className="exchange-index-value">등록된 기기 없음</p>}
      {chosen && <>
        <span className="workspace-section-label">보기</span>
        <div className="exchange-filter" role="group" aria-label="보기">
          <button type="button" aria-pressed={!receivedOnly} onClick={() => setReceivedOnly(false)}>전체</button>
          <button type="button" aria-pressed={receivedOnly} onClick={() => setReceivedOnly(true)}>받은 파일</button>
        </div>
      </>}
    </div>
    <div className="exchange-index-foot">
      <p className="exchange-index-label">받은 파일 저장 위치</p>
      <p className="exchange-index-value exchange-folder" title={snapshot.folder ?? undefined}>{snapshot.folder ?? "다운로드 폴더를 찾을 수 없음"}</p>
      <div className="exchange-index-links">
        <Button size="sm" variant="ghost" onClick={() => void store.openFolder().catch((reason) => setError(commandErrorMessage(reason, "폴더를 열지 못했습니다.")))}>폴더 열기</Button>
      </div>
      {availability.state !== "unavailable" && <details className="exchange-token-details"><summary>이 PC 전용 토큰</summary><TokenForm store={store} configured={snapshot.tokenConfigured} onError={setError} /></details>}
    </div>
  </div>;

  const peer = chosen?.name ?? "";
  const emptyText = chosen
    ? { title: receivedOnly ? `${peer}에게서 받은 파일이 없습니다` : `${withParticle(peer, "과", "와")} 주고받은 파일이 없습니다`, text: "보낸 파일과 받은 파일이 여기에 시간순으로 쌓입니다. 받은 파일은 창을 닫아 트레이에 있어도 다운로드/Lakomics에 저장됩니다." }
    : { title: "받을 기기가 없습니다", text: "태블릿에서 Lakomics의 전송 화면을 한 번 열면 여기에 나타납니다." };
  return <div className={`exchange-workspace${dragging !== null ? " is-drop-target" : ""}`}>
    <ViewToolbar title={chosen?.name ?? "전송"} chrome={{ navigation, status: <span className="exchange-status" role="status">{statusText}</span> }} />
    {availability.state === "unavailable" && <div className="exchange-notice" role="alert">
      <p>{availability.message ?? "보내기/받기를 쓸 수 없습니다."}</p>
      {availability.needsToken && <TokenForm store={store} configured={snapshot.tokenConfigured} onError={setError} />}
    </div>}
    {error && <div className="exchange-error" role="alert"><span>{error}</span><Button size="sm" variant="ghost" onClick={() => setError(null)}>닫기</Button></div>}
    <div className="exchange-body" ref={scroller}>
      {blocks.length
        ? <ol className="exchange-timeline" aria-label={`${withParticle(peer, "과", "와")} 주고받은 파일`}>
            {blocks.map((block, index) => <Fragment key={block.key}>
              {dayKey(block.at) && dayKey(block.at) !== dayKey(blocks[index - 1]?.at ?? "") && <DaySeparator at={block.at} />}
              <Block block={block} peerName={peerOf(block.entries[0].row).name || peer} store={store} onError={setError} />
            </Fragment>)}
          </ol>
        : <div className="exchange-empty">
            <span className="exchange-empty-glyph" aria-hidden="true"><ArrowsUpDownIcon /></span>
            <h3>{emptyText.title}</h3>
            <p>{emptyText.text}</p>
            {chosen && !receivedOnly && <ul className="exchange-limits"><li>파일당 최대 2GB</li><li>한 번에 100개까지</li><li>안 받으면 24시간 뒤 삭제</li></ul>}
          </div>}
    </div>
    {chosen && <footer className="exchange-composer">
      <p className="exchange-composer-to"><b>{peer}(으)로 보내기</b>파일이나 폴더를 이 창에 끌어 놓아도 됩니다 · 파일당 최대 2GB · 폴더는 zip 하나로</p>
      <Button onClick={() => void choose(pickFolder)}><FolderIcon aria-hidden="true" />폴더 보내기</Button>
      <Button variant="primary" onClick={() => void choose(pickFiles)}><PaperClipIcon aria-hidden="true" />파일 보내기</Button>
    </footer>}
    {dragging !== null && <div className="exchange-drop-veil" aria-hidden="true">
      <strong>{chosen ? `놓으면 ${peer}(으)로 보냅니다` : "받을 기기가 없어 보낼 수 없습니다"}</strong>
      {dragging > 0 && <span>항목 <span className="numeric">{dragging}</span>개 · 폴더는 zip 하나로</span>}
    </div>}
  </div>;
}

function DaySeparator({ at }: { at: string }) {
  const { date, note } = dayLabel(at);
  return <li className="exchange-day" aria-label={`${date} ${note}`}><span className="numeric">{date}</span>{note}</li>;
}
