import type { ReactNode } from "react";

export type ActivityItem = {
  id: string;
  kind: string;
  label: string;
  state: "running" | "queued" | "paused" | "failed" | "done";
  done: number;
  total?: number | null;
  detail?: string | null;
  countText?: string;
  /** Finished rows folded into this one (same title, subtitle and outcome); only set above 1. */
  repeat?: number;
  pauseGroup?: string | null;
  pausedReason?: string | null;
  error?: string | null;
  startedAt?: number;
  finishedAt?: number | null;
  pause?: () => void;
  retry?: () => void;
  dismiss?: () => void;
  open?: () => void;
  result?: ReactNode;
};
type Entry = { item: ActivityItem; started: number; finished?: number; shown?: number; held?: ActivityItem };
export type ActivitySections = { problems: ActivityItem[]; running: ActivityItem[]; waiting: ActivityItem[]; recent: ActivityItem[]; deadline?: number };
export const RECENT_MS = 3_600_000;

/** Local deadlines reveal slow jobs and expire history. They never request native data. */
export class ActivityTimeline {
  private entries = new Map<string, Entry>();
  read(items: ActivityItem[], now: number): ActivitySections {
    const ids = new Set(items.map(item => item.id));
    const sections: ActivitySections = { problems: [], running: [], waiting: [], recent: [] };
    const deadline = (at: number) => { if (at > now) sections.deadline = Math.min(sections.deadline ?? Infinity, at); };
    for (const [id, entry] of this.entries) if (!ids.has(id)) {
      if (entry.item.state === "running" && entry.shown !== undefined && now < entry.shown + 1000) {
        sections.running.push(entry.item); deadline(entry.shown + 1000);
      } else this.entries.delete(id);
    }
    for (const item of items) {
      let entry = this.entries.get(item.id);
      if (!entry || (["done", "failed", "queued", "paused"].includes(entry.item.state) && item.state === "running")) {
        const started = entry ? now : item.startedAt ?? now;
        entry = { item, started };
        this.entries.set(item.id, entry);
      }
      if (item.state === "done" && entry.finished === undefined) {
        entry.finished = item.finishedAt ?? now;
        if (entry.shown !== undefined && entry.item.state === "running") entry.held = entry.item;
      }
      entry.item = item;
      if (item.state === "failed") { sections.problems.push(item); continue; }
      if (item.state === "running") {
        if (now - entry.started > 1000) {
          entry.shown ??= now;
          sections.running.push(item);
        } else deadline(entry.started + 1001);
      } else if (item.state === "queued" || item.state === "paused") sections.waiting.push(item);
      else if (entry.held && entry.shown !== undefined && now < entry.shown + 1000) {
        sections.running.push(entry.held);
        deadline(entry.shown + 1000);
      } else if (now - (entry.finished ?? now) < RECENT_MS) {
        sections.recent.push(item);
        deadline((entry.finished ?? now) + RECENT_MS);
      }
    }
    sections.recent.sort((a, b) => (this.entries.get(b.id)?.finished ?? 0) - (this.entries.get(a.id)?.finished ?? 0));
    sections.recent = groupRecent(sections.recent).slice(0, 10);
    return sections;
  }
}

/**
 * Folds identical finished rows (same title, subtitle and outcome) into the newest one. The folded row keeps a
 * key derived from its content, so a new duplicate updates the count in place instead of replacing the row.
 * Input is newest first; dismissing the folded row dismisses every member.
 */
function groupRecent(items: ActivityItem[]): ActivityItem[] {
  const groups = new Map<string, ActivityItem[]>();
  for (const item of items) {
    const key = JSON.stringify([item.label, item.detail ?? "", item.state, item.error ?? ""]);
    groups.set(key, [...(groups.get(key) ?? []), item]);
  }
  return [...groups].map(([key, members]) => {
    const dismissals = members.map(member => member.dismiss).filter((close): close is () => void => Boolean(close));
    return { ...members[0], id: `recent:${key}`, repeat: members.length > 1 ? members.length : undefined,
      dismiss: dismissals.length ? () => dismissals.forEach(close => close()) : undefined };
  });
}
