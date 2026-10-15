import { useEffect, useRef, useState, memo } from "react";
import { ArrowDownTrayIcon, ArrowUpTrayIcon, CheckIcon, ChevronDownIcon, ChevronRightIcon, CloudArrowUpIcon, ExclamationCircleIcon, PhotoIcon, PauseIcon, PlayIcon, UserIcon, Square2StackIcon, XMarkIcon, ArrowPathIcon } from "@heroicons/react/24/outline";
import { EmptyState } from "../shared/ui/EmptyState";
import { ActivityTimeline, type ActivityItem, type ActivitySections } from "./activityTimeline";
import "./ActivityList.css";

let recentExpanded = false;
export function useActivitySections(items: ActivityItem[]) {
  const timeline = useRef(new ActivityTimeline());
  const [, tick] = useState(0);
  const sections = timeline.current.read(items, Date.now());
  useEffect(() => {
    if (sections.deadline === undefined) return;
    const timer = window.setTimeout(() => tick(n => n + 1), Math.max(1, sections.deadline! - Date.now()));
    return () => window.clearTimeout(timer);
  }, [sections.deadline]);
  return sections;
}

export function ActivityList({ sections }: { sections: ActivitySections }) {
  const [expanded, setExpanded] = useState(recentExpanded);
  return <div className="activity-list">
    <Rows items={sections.problems} label="문제" />
    <Rows items={sections.running} label="진행 중" />
    {sections.waiting.length > 0 && <div className="activity-list__sub">대기 <span>{sections.waiting.length}</span></div>}
    <Rows items={sections.waiting} label="대기" />
    {!sections.problems.length && !sections.running.length && !sections.waiting.length && !sections.recent.length
      && <EmptyState inline title="진행 중인 작업 없음" />}
    {sections.recent.length > 0 && <>
      <button type="button" className="activity-list__fold" aria-expanded={expanded} onClick={() => setExpanded(recentExpanded = !expanded)}>
        {expanded ? <ChevronDownIcon aria-hidden="true" /> : <ChevronRightIcon aria-hidden="true" />}
        최근 끝남 <span>{sections.recent.length}</span>
      </button>
      {expanded && <Rows items={sections.recent} label="최근 끝남" />}
    </>}
  </div>;
}

function Rows({ items, label }: { items: ActivityItem[]; label: string }) {
  const [displayed, setDisplayed] = useState(items);
  const ids = new Set(items.map(item => item.id));
  const exiting = displayed.filter(item => !ids.has(item.id));
  const signature = items.map(item => item.id).join("|");
  useEffect(() => {
    const instant = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    if (instant || !exiting.length) { setDisplayed(items); return; }
    const timer = window.setTimeout(() => setDisplayed(items), 140);
    return () => window.clearTimeout(timer);
    // Progress changes update row content below, without restarting entrance/exit.
  }, [signature, exiting.length]);
  const rows = [...items, ...exiting];
  if (!rows.length) return null;
  return <div role="group" aria-label={label} className="activity-list__group">
    {rows.map(item => <div key={item.id} className="activity-list__motion" aria-hidden={!ids.has(item.id) || undefined} data-exiting={!ids.has(item.id) || undefined}>
      <div className="activity-list__clip"><ActivityRow item={item} /></div>
    </div>)}
  </div>;
}

const ActivityRow = memo(function ActivityRow({ item }: { item: ActivityItem }) {
  const [resultOpen, setResultOpen] = useState(false);
  const failed = item.state === "failed";
  const paused = item.pausedReason === "일시 정지됨" || (item.state === "paused" && !item.pausedReason);
  const Icon = failed ? ExclamationCircleIcon : item.kind.startsWith("character") || item.kind === "reference_reinforcement" ? UserIcon
    : item.kind === "cloud_upload" ? CloudArrowUpIcon : item.kind.includes("send") || item.kind.includes("export") ? ArrowUpTrayIcon
      : item.kind.includes("import") || item.kind.includes("ingest") || item.kind.includes("receive") ? ArrowDownTrayIcon
        : item.kind === "preparation" ? PhotoIcon : item.state === "done" ? CheckIcon : Square2StackIcon;
  const count = item.countText ?? (item.total != null ? `${item.done.toLocaleString()} / ${item.total.toLocaleString()}` : item.done > 0 ? `${item.done.toLocaleString()}개` : "");
  const detail = item.error ?? item.detail;
  return <>
    <div className="activity-row" data-problem={failed || undefined} data-waiting={item.state === "queued" || item.state === "paused" || undefined} data-detail={Boolean(detail) || undefined} role={failed ? "alert" : undefined}>
      <Icon className="activity-row__icon" aria-hidden="true" />
      <div className="activity-row__body">
        <div className="activity-row__line"><span className="activity-row__name">{item.label}</span>
          <span className="activity-row__count">{[count, item.pausedReason, item.repeat && `×${item.repeat.toLocaleString()}`].filter(Boolean).join(" · ")}</span></div>
        {detail && <div className="activity-row__detail" title={detail}>{detail}</div>}
      </div>
      {item.total != null && item.total > 0 && item.state === "running" && <span className="activity-row__meter" role="progressbar" aria-label={`${item.label} 진행률`} aria-valuemin={0} aria-valuemax={item.total} aria-valuenow={Math.min(item.done, item.total)}><span style={{ width: `${Math.min(100, item.done / item.total * 100)}%` }} /></span>}
      {item.pause && !failed && item.state !== "done" && <button type="button" className="activity-row__button" aria-label={`${item.label} ${paused ? "재개" : "일시 정지"}`} onClick={item.pause}>{paused ? <PlayIcon aria-hidden="true" /> : <PauseIcon aria-hidden="true" />}</button>}
      {failed && item.retry && <button type="button" className="activity-row__button" aria-label={`${item.label} 다시 시도`} onClick={item.retry}><ArrowPathIcon aria-hidden="true" /></button>}
      {item.open && <button type="button" className="activity-row__button" aria-label={`${item.label} 열기`} onClick={item.open}><ChevronRightIcon aria-hidden="true" /></button>}
      {item.result && <button type="button" className="activity-row__button" aria-label={`${item.label} 결과 열기`} aria-expanded={resultOpen} onClick={() => setResultOpen(!resultOpen)}><ChevronRightIcon aria-hidden="true" /></button>}
      {item.dismiss && (failed || item.state === "done") && <button type="button" className="activity-row__button" aria-label={`${item.label} 닫기`} onClick={item.dismiss}><XMarkIcon aria-hidden="true" /></button>}
    </div>
    {resultOpen && <div className="activity-row__result">{item.result}</div>}
  </>;
});

/** Test isolation only; no settings or persistent storage is used. */
export function resetActivityFold() { recentExpanded = false; }
