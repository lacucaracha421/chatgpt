import type { ExchangeOutgoing } from "../exchange/exchangeStore";
import { blockRoute, type ExchangeRoute } from "../exchange/route";
import { batchProgress, isImageName } from "../exchange/timeline";

/** One line of Home's 전송 tile: a send, or several files sent together. */
export type TransferLine = {
  key: string;
  label: string;
  /** moving: on its way (with a percent); waiting: on the server until the tablet takes it. */
  state: "moving" | "waiting" | "done" | "failed" | "ended";
  percent: number | null;
  /** ISO time; null while it has only just been queued. */
  at: string | null;
  /** How it travelled when every file went the same direct way; null for the server (or a mix). */
  route: ExchangeRoute | null;
};

const MOVING = new Set<ExchangeOutgoing["state"]>(["queued", "zipping", "hashing", "uploading"]);
const FAILED = new Set<ExchangeOutgoing["state"]>(["failed", "interrupted"]);

/** The newest sends, files of one batch folded into one line. */
export function recentTransfers(outgoing: ExchangeOutgoing[], limit = 3): TransferLine[] {
  const groups = new Map<string, ExchangeOutgoing[]>();
  for (const row of outgoing) {
    const key = row.batchId || row.transferId;
    groups.set(key, [...(groups.get(key) ?? []), row]);
  }
  const time = (rows: ExchangeOutgoing[]) => {
    const stamps = rows.map(row => Date.parse(row.createdAt ?? "")).filter(Number.isFinite);
    // A send without a time has only just been queued: the newest.
    return stamps.length ? Math.max(...stamps) : Number.POSITIVE_INFINITY;
  };
  return [...groups.entries()]
    .map(([key, rows]) => ({ key, rows, time: time(rows) }))
    .sort((a, b) => (b.time === a.time ? 0 : b.time > a.time ? 1 : -1))
    .slice(0, limit)
    .map(({ key, rows }): TransferLine => {
      const progress = batchProgress(rows.map(row => {
        const size = Math.max(0, row.sizeBytes);
        const finished = row.state === "waiting" || row.state === "delivered";
        return { size, done: finished ? size : row.state === "uploading" ? row.done : 0, finished };
      }));
      const state: TransferLine["state"] = rows.some(row => FAILED.has(row.state)) ? "failed"
        : rows.some(row => MOVING.has(row.state)) ? "moving"
        : rows.some(row => row.state === "waiting") ? "waiting"
        : rows.every(row => row.state === "delivered") ? "done" : "ended";
      const label = rows.length === 1 ? rows[0]!.fileName
        : rows.every(row => isImageName(row.fileName)) ? `사진 ${rows.length}장` : `파일 ${rows.length}개`;
      const stamps = rows.map(row => row.createdAt).filter((at): at is string => Boolean(at)).sort();
      return { key, label, state, percent: state === "moving" ? progress.percent : null, at: stamps[0] ?? null, route: blockRoute(rows.map(row => row.route)) };
    });
}
