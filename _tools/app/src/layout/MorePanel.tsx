import { SectionLabel } from "../shared/ui/SectionLabel";
import { useState } from "react";
import { EllipsisHorizontalIcon } from "@heroicons/react/24/outline";
import { AnchoredPanel } from "../shared/ui/AnchoredPanel";
import { CountBadge } from "../shared/ui/Badge";
import { NAVIGATION_GROUP_LABELS, type NavigationEntry } from "./navigationEntries";

/** The rail's 더보기 entry: non-empty review queues first, then every destination that left the rail. */
export function MorePanel({ entries, current = false, onOpenChange }: { entries: NavigationEntry[]; current?: boolean; onOpenChange?: (open: boolean) => void }) {
  const [open, setOpenState] = useState(false);
  const setOpen = (next: boolean) => { setOpenState(next); onOpenChange?.(next); };
  const queues = entries.filter((entry) => entry.group === "queue");
  const destinations = entries.filter((entry) => entry.group === "go");
  // Only 유사 검토 feeds the rail mark: 미분류 is usually large and would keep it on permanently.
  const queueTotal = queues.find((entry) => entry.id === "review")?.count ?? 0;
  const activity = entries.find((entry) => entry.activity)?.activity;
  const label = queueTotal > 0 ? `더보기 · 유사 검토 ${queueTotal.toLocaleString()}개` : "더보기";
  return <AnchoredPanel
    open={open}
    onOpenChange={setOpen}
    title="더보기"
    anchor="rail"
    showHeader={false}
    trigger={<button type="button" className="workspace-rail__item" aria-label={label} aria-description={activity} title={activity}
      aria-current={current ? "page" : undefined}>
      <span className="workspace-rail__icon">
        <EllipsisHorizontalIcon aria-hidden="true" />
        {queueTotal > 0 && <CountBadge variant="corner" className="workspace-rail__count" aria-hidden="true" value={queueTotal} max={99} />}
      </span>
      <span>더보기</span>
      {activity && <span className="workspace-rail__activity" aria-hidden="true" />}
    </button>}
  >
    <MoreEntryList entries={queues} heading={NAVIGATION_GROUP_LABELS.queue} onRun={() => setOpen(false)} />
    <MoreEntryList entries={destinations} heading={NAVIGATION_GROUP_LABELS.go} onRun={() => setOpen(false)} />
  </AnchoredPanel>;
}

/** A list of navigation entries as index links; also used as the index fallback on 관리-type screens. */
export function MoreEntryList({ entries, heading, onRun }: { entries: NavigationEntry[]; heading: string; onRun?: () => void }) {
  if (!entries.length) return null;
  return <nav className="more-panel__navigation" aria-label={heading}>
    <SectionLabel className="workspace-section-label" title={heading} />
    {entries.map((entry) => <button key={entry.id} type="button" className="workspace-index-link"
      aria-label={entry.count === undefined ? undefined : `${entry.label} ${entry.count.toLocaleString()}개`}
      aria-current={entry.selected ? "page" : undefined} aria-description={entry.activity}
      onClick={() => { onRun?.(); entry.run(); }}>
      <span className="ui-menu__item-icon" aria-hidden="true">{entry.icon}</span>
      <span className="more-panel__label">{entry.label}</span>
      {entry.count !== undefined && <span className="more-panel__count">{entry.count.toLocaleString()}</span>}
      {entry.activity && <span className="more-panel__activity" aria-hidden="true" />}
    </button>)}
  </nav>;
}
