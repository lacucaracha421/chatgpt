import { useEffect, useRef, useState } from "react";
import { StarIcon } from "@heroicons/react/24/outline";
import { ChevronDownIcon } from "@heroicons/react/24/outline";
import type { CollectionSummary, CollectionRecordEdit, CollectionWorkRecord } from "../../library/types";
import { displayDate } from "../../shared/displayDate";
import { Menu } from "../../shared/ui/Menu";
import { TextInput } from "../../shared/ui/TextInput";
import { SectionLabel } from "../../shared/ui/SectionLabel";
import { Toast } from "../../shared/ui/Toast";

export const recordStates: Record<string, readonly [string, string][]> = {
  game: [["done", "다 함"], ["playing", "하는 중"], ["unplayed", "안 함"]],
  av: [["watched", "다 봄"], ["unwatched", "안 봄"]],
  movie: [["watched", "다 봄"], ["watching", "보는 중"], ["unwatched", "안 봄"]],
  manga: [["collecting", "모으는 중"], ["complete", "다 모음"]],
};
export function statusLabel(type: string, status: string | null) {
  return recordStates[type]?.find(([id]) => id === status)?.[1] ?? "미입력";
}
export function defaultRecord(collection: CollectionSummary): CollectionWorkRecord {
  return { status: null, ownedPlatform: null, myScore: collection.myScore, memo: collection.description };
}
/** The 기기 choices: the work's listed platforms, the one already recorded, then the common consoles. Shared with the tablet. */
export function platformOptions(platforms: string | null | undefined, owned: string | null | undefined): string[] {
  return [...new Set([...(platforms ?? "").split(/\s*[,·|]\s*/).filter(Boolean), ...(owned ? [owned] : []), "PC", "Switch", "Switch 2", "PS4", "PS5", "Xbox One", "Xbox Series X/S", "Steam Deck"])];
}
export function RecordStars({ score, onChange, disabled = false }: { score: number | null; onChange?(score: number | null): void; disabled?: boolean }) {
  // Stars are the personal rating control; a half already stored remains visible.
  return <span className="work-stars" role={onChange ? "group" : "img"} aria-label={`별점 ${score ?? "미평가"}`}>
    {[1, 2, 3, 4, 5].map(value => {
      const star = <><StarIcon aria-hidden="true" /><span style={{ width: `${Math.max(0, Math.min(1, (score ?? 0) - value + 1)) * 100}%` }}><StarIcon aria-hidden="true" /></span></>;
      const current = score !== null && score > 0 && Math.ceil(score) === value;
      return onChange ? <button className="work-star" key={value} type="button" disabled={disabled} aria-label={`별점 ${value}점`} aria-description={current ? `현재 ${score}점, 다시 누르면 해제` : undefined} aria-pressed={current} onClick={() => onChange(current ? null : value)}>{star}</button> : <span className="work-star" key={value}>{star}</span>;
    })}
  </span>;
}
export function WorkRecordEditor({ collection, record, onSave }: { collection: CollectionSummary; record: CollectionWorkRecord; onSave(edit: CollectionRecordEdit): Promise<CollectionWorkRecord> }) {
  const [draft, setDraft] = useState(record);
  const [feedback, setFeedback] = useState<{ message: string; failed: boolean } | null>(null);
  const [busy, setBusy] = useState(false);
  const memoDirty = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const queue = useRef(Promise.resolve());
  const pendingSaves = useRef(0);
  const pendingEdits = useRef(new Map<CollectionRecordEdit["field"], CollectionRecordEdit>());
  const confirmed = useRef(record);
  const retry = useRef<CollectionRecordEdit | null>(null);
  const target = useRef(collection.id); target.current = collection.id;
  const memoValue = useRef(record.memo);
  const saveRef = useRef(onSave); saveRef.current = onSave;
  useEffect(() => {
    if (pendingSaves.current === 0) confirmed.current = record;
    setDraft(current => ({ ...record, ...Object.fromEntries([...pendingEdits.current.values()].map(edit => [edit.field, edit.value])), memo: memoDirty.current ? current.memo : record.memo }));
  }, [record]);
  useEffect(() => {
    const id = collection.id;
    memoDirty.current = false; memoValue.current = record.memo; confirmed.current = record; pendingEdits.current.clear(); setDraft(record); setFeedback(null);
    return () => {
      // Only flush an unsent draft, behind any earlier write. Never let a close
      // submit the new memo ahead of an older in-flight save of the same field.
      if (timer.current) {
        clearTimeout(timer.current); timer.current = null;
        const value = memoValue.current;
        queue.current = queue.current.then(async () => { await onSave({ field: "memo", value }); }).catch(() => undefined);
      }
      if (target.current === id) memoDirty.current = false;
    };
  }, [collection.id]); // The cleanup retains the exact work/save callback it opened with.
  function save(edit: CollectionRecordEdit) {
    const id = collection.id;
    const operation = saveRef.current;
    pendingSaves.current += 1;
    if (edit.field === "memo" && !memoDirty.current) { memoDirty.current = true; memoValue.current = edit.value; }
    pendingEdits.current.set(edit.field, edit);
    setDraft(current => ({ ...current, [edit.field]: edit.value }));
    setBusy(true); setFeedback(null); retry.current = edit;
    queue.current = queue.current.then(async () => {
      try {
        const next = await operation(edit);
        if (target.current !== id) return;
        confirmed.current = next;
        if (pendingEdits.current.get(edit.field) === edit) pendingEdits.current.delete(edit.field);
        if (edit.field === "memo" && memoValue.current === edit.value) memoDirty.current = false;
        setDraft(current => ({ ...next, ...Object.fromEntries([...pendingEdits.current.values()].map(pending => [pending.field, pending.value])), memo: memoDirty.current ? current.memo : next.memo }));
        retry.current = null; setFeedback({ message: "저장됨", failed: false });
      } catch (reason) {
        if (target.current === id) {
          if (pendingEdits.current.get(edit.field) === edit) {
            pendingEdits.current.delete(edit.field);
            if (edit.field !== "memo" || memoValue.current === edit.value) {
              if (edit.field === "memo") { memoDirty.current = false; memoValue.current = confirmed.current.memo; }
              setDraft(current => ({ ...current, [edit.field]: confirmed.current[edit.field] }));
            }
          }
          setFeedback({ message: reason instanceof Error ? reason.message : "기록을 저장하지 못했습니다.", failed: true });
        }
      } finally { pendingSaves.current -= 1; if (target.current === id) setBusy(pendingSaves.current > 0); }
    });
  }
  function editMemo(value: string) {
    memoDirty.current = true; memoValue.current = value || null;
    setDraft(current => ({ ...current, memo: value }));
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => { timer.current = null; save({ field: "memo", value: value || null }); }, 600);
  }
  const platforms = platformOptions(collection.platforms, draft.ownedPlatform);
  return <section className="work-record"><SectionLabel title="내 기록" /><dl>
    <div><dt>들인 날</dt><dd>{displayDate(collection.createdAt)}</dd></div>
    <div><dt>상태</dt><dd><Menu label="상태" triggerClassName="work-record-menu" disabled={busy} trigger={<>{statusLabel(collection.type, draft.status)}<ChevronDownIcon /></>} items={[["", "미입력"], ...(recordStates[collection.type] ?? [])].map(([id, label]) => ({ id, label, group: "status", selected: (draft.status ?? "") === id, onSelect: () => { setDraft(current => ({ ...current, status: id || null })); save({ field: "status", value: id || null }); } }))} /></dd></div>
    <div><dt>별점</dt><dd><RecordStars score={draft.myScore} disabled={busy} onChange={value => { setDraft(current => ({ ...current, myScore: value })); save({ field: "myScore", value }); }} /></dd></div>
    {collection.type === "game" && <div><dt>기기</dt><dd><Menu label="소유 기기" disabled={busy} triggerClassName="work-record-menu" trigger={<>{draft.ownedPlatform ?? "미입력"}<ChevronDownIcon /></>} items={["", ...platforms].map(value => ({ id: value, label: value || "미입력", group: "platform", selected: (draft.ownedPlatform ?? "") === value, onSelect: () => { setDraft(current => ({ ...current, ownedPlatform: value || null })); save({ field: "ownedPlatform", value: value || null }); } }))} /></dd></div>}
    <div><dt>메모</dt><dd><TextInput aria-label="메모" className="work-record-memo" placeholder="메모 남기기" value={draft.memo ?? ""} onChange={event => editMemo(event.target.value)} onBlur={() => { if (timer.current) { clearTimeout(timer.current); timer.current = null; save({ field: "memo", value: memoValue.current || null }); } }} /></dd></div>
  </dl>{feedback && <Toast tone={feedback.failed ? "error" : "status"} onDismiss={() => setFeedback(null)} actionLabel={feedback.failed ? "다시 시도" : undefined} onAction={feedback.failed ? () => { if (retry.current) save(retry.current); } : undefined}>{feedback.message}</Toast>}</section>;
}
