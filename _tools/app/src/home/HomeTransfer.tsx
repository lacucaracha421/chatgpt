import { useEffect, useRef, useState } from "react";
import { ArrowsUpDownIcon, CheckIcon, ClockIcon, ExclamationTriangleIcon, XMarkIcon, ChevronRightIcon } from "@heroicons/react/24/outline";
import { nativeDropClientPoint } from "../app/workspaceDragTargets";
import { exchangeStore, useExchangeSnapshot, type ExchangeStore } from "../exchange/exchangeStore";
import { routeWord } from "../exchange/route";
import { dayKey } from "../exchange/timeline";
import { claimNativeDrop } from "../ingestion/dropClaims";
import { subscribeToTauriDrops, type DropSubscriber } from "../ingestion/useFileDrop";
import { commandErrorMessage } from "../library/errorMessage";
import { displayDate, displayTime } from "../shared/displayDate";
import { SectionLabel } from "../shared/ui/SectionLabel";
import { HomePresence } from "./HomeAttention";
import { recentTransfers, type TransferLine } from "./homeTransferModel";
import "./homeTools.css";

export type PickFiles = () => Promise<string[] | null>;
const pickWithDialog: PickFiles = async () => {
  const { open } = await import("@tauri-apps/plugin-dialog");
  const picked = await open({ multiple: true, directory: false, title: "보낼 파일" });
  return picked ? (Array.isArray(picked) ? picked : [picked]) : null;
};

type Props = {
  /** The page's local day, to tell a time from a date. */
  at: Date;
  /** The Home area is shown; a hidden Home never takes a drop. */
  enabled: boolean;
  /** Opens the full 전송 screen. */
  onOpenDetail: () => void;
  store?: ExchangeStore;
  subscribeDrops?: DropSubscriber;
  pickFiles?: PickFiles;
};

function Mark({ line }: { line: TransferLine }) {
  if (line.state === "moving") return <span className="home-sent__meter" role="progressbar" aria-label={`${line.label} 진행률`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={line.percent ?? 0}><i style={{ width: `${line.percent ?? 0}%` }} /></span>;
  if (line.state === "done") return <CheckIcon aria-hidden="true" />;
  if (line.state === "waiting") return <ClockIcon aria-hidden="true" />;
  if (line.state === "failed") return <ExclamationTriangleIcon aria-hidden="true" />;
  return <XMarkIcon aria-hidden="true" />;
}

export function HomeTransfer({ at, enabled, onOpenDetail, store = exchangeStore, subscribeDrops = subscribeToTauriDrops, pickFiles = pickWithDialog }: Props) {
  const snapshot = useExchangeSnapshot(store);
  const { availability } = snapshot;
  const device = snapshot.devices[0] ?? null;
  const [over, setOver] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const tile = useRef<HTMLElement>(null);
  const canSend = Boolean(device) && (availability.state === "ready" || availability.state === "offline");
  // Why nothing can be sent. While the connection is still starting there is no reason to give yet.
  const blocked = availability.state === "unavailable" ? availability.message ?? "보내기/받기를 쓸 수 없습니다."
    : availability.state === "held" ? "받기만 · 파일 교환 보류"
    : availability.state === "starting" ? null
    : !device ? "받을 기기가 없습니다" : null;

  async function send(paths: string[]) {
    if (!paths.length || !device) return;
    setError(null);
    try { await store.send(paths, device.deviceId); } catch (reason) { setError(commandErrorMessage(reason, "파일을 보내지 못했습니다.")); }
  }
  const live = useRef({ send, canSend, enabled });
  live.current = { send, canSend, enabled };

  // The whole tile takes the drop; the app-wide import ignores a drag over it (dropClaims).
  useEffect(() => {
    const element = tile.current;
    return element ? claimNativeDrop(element) : undefined;
  }, []);
  useEffect(() => {
    let active = true;
    let stop: (() => void) | undefined;
    const inside = (position: { x: number; y: number }) => {
      const box = tile.current?.getBoundingClientRect();
      const point = nativeDropClientPoint(position);
      return !!box && box.width > 0 && box.height > 0 && point.x >= box.left && point.x <= box.right && point.y >= box.top && point.y <= box.bottom;
    };
    void subscribeDrops((event) => {
      if (!active) return;
      if (event.type === "leave" || event.type === "cancel") { setOver(false); return; }
      const here = live.current.enabled && inside(event.position);
      if (event.type === "drop") {
        setOver(false);
        if (here && live.current.canSend) void live.current.send(event.paths);
        return;
      }
      setOver(here);
    }).then((unlisten) => { if (active) stop = unlisten; else unlisten(); }).catch(() => undefined);
    return () => { active = false; stop?.(); };
  }, [subscribeDrops]);

  async function choose() {
    try { const paths = await pickFiles(); if (paths) await send(paths); } catch (reason) { setError(commandErrorMessage(reason, "보낼 항목을 선택하지 못했습니다.")); }
  }

  const lines = recentTransfers(snapshot.outgoing);
  const today = dayKey(at.toISOString());
  const trail = (line: TransferLine) => line.state === "moving" ? `${line.percent ?? 0}%`
    : line.state === "waiting" ? "받기 대기"
    : line.state === "failed" ? "실패"
    : line.state === "ended" ? "취소됨"
    : !line.at ? "" : dayKey(line.at) === today ? displayTime(line.at) : displayDate(line.at, at);
  const label = canSend ? `놓으면 ${device!.name}(으)로 보냅니다` : blocked ?? "파일을 놓아 보내기";

  return <section ref={tile} className="home-attention-section home-tool home-transfer" aria-label="전송" data-over={over && canSend ? "" : undefined}>
    <SectionLabel title="전송" actions={<button type="button" className="home-link" onClick={onOpenDetail}>상세<ChevronRightIcon aria-hidden="true" /></button>} />
    <div className="home-tool__body">
      {/* Icon only (user 2026-10-15); the sentence stays as the name and tooltip. */}
      <button type="button" className="home-drop" disabled={!canSend} aria-label={label} title={label} onClick={() => void choose()}>
        <ArrowsUpDownIcon aria-hidden="true" />
      </button>
      {error && <p className="home-transfer__error" role="alert">{error}</p>}
      <div className="home-sent">
        <HomePresence items={lines.map(line => ({ key: line.key, content: <div className="home-sent__row" data-state={line.state}>
          <Mark line={line} />
          <span>{line.label}</span>
          <small className="numeric">{[routeWord(line.route), trail(line)].filter(Boolean).join(" · ")}</small>
        </div> }))} />
      </div>
    </div>
  </section>;
}
