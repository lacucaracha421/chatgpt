import { Bars3Icon, ChevronDownIcon, ChevronRightIcon, PlusIcon, XMarkIcon } from "@heroicons/react/24/outline";
import { useLayoutEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import { byOrder, keyBetween, NOTE_LIMITS, placeInGroup, type ChecklistItem } from "./model";

type Props = { items: ChecklistItem[]; readOnly?: boolean; onChange: (items: ChecklistItem[]) => void };

/**
 * Checklist editing: Enter adds below, Backspace on an empty item removes it, Ctrl+Enter
 * toggles, Alt+Up/Down moves; the handle drags with pointer events. Checked items move
 * into a collapsible 완료 group. A move rewrites only the moved item's order key.
 */
export function ChecklistEditor({ items, readOnly = false, onChange }: Props) {
  const open = items.filter((item) => !item.checked).sort(byOrder);
  const done = items.filter((item) => item.checked).sort(byOrder);
  const [doneOpen, setDoneOpen] = useState(true);
  const [drag, setDrag] = useState<{ id: string; index: number } | null>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const focus = useRef<{ id: string; caret: "start" | "end" } | null>(null);

  useLayoutEffect(() => {
    const target = focus.current;
    if (!target) return;
    focus.current = null;
    const input = listRef.current?.parentElement?.querySelector<HTMLInputElement>(`input[data-item-id="${target.id}"]`);
    if (!input) return;
    input.focus();
    const at = target.caret === "end" ? input.value.length : 0;
    input.setSelectionRange(at, at);
  });

  const update = (id: string, change: Partial<ChecklistItem>) => onChange(items.map((item) => (item.id === id ? { ...item, ...change } : item)));
  function insertAfter(index: number) {
    if (items.length >= NOTE_LIMITS.items) return;
    const id = crypto.randomUUID();
    let next = [...items, { id, text: "", checked: false, order: keyBetween(open[open.length - 1]?.order ?? null, null) }];
    const group = [...open.slice(0, index + 1), next[next.length - 1]!, ...open.slice(index + 1)];
    next = placeInGroup(next, group, id, index + 1);
    focus.current = { id, caret: "start" };
    onChange(next);
  }
  function remove(item: ChecklistItem, focusPrevious: boolean) {
    const index = open.findIndex((entry) => entry.id === item.id);
    const previous = index > 0 ? open[index - 1] : open[index + 1];
    if (focusPrevious && previous) focus.current = { id: previous.id, caret: "end" };
    onChange(items.filter((entry) => entry.id !== item.id));
  }
  function move(item: ChecklistItem, to: number) {
    const group = item.checked ? done : open;
    if (to < 0 || to >= group.length) return;
    focus.current = { id: item.id, caret: "end" };
    onChange(placeInGroup(items, group, item.id, to));
  }
  function keyDown(event: KeyboardEvent<HTMLInputElement>, item: ChecklistItem, index: number) {
    if (event.nativeEvent.isComposing) return;
    if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
      event.preventDefault();
      focus.current = { id: item.id, caret: "end" };
      update(item.id, { checked: !item.checked });
    } else if (event.altKey && (event.key === "ArrowUp" || event.key === "ArrowDown")) {
      event.preventDefault();
      move(item, index + (event.key === "ArrowUp" ? -1 : 1));
    } else if (event.key === "Enter" && !item.checked) {
      event.preventDefault();
      insertAfter(index);
    } else if (event.key === "Backspace" && item.text === "") {
      event.preventDefault();
      remove(item, true);
    }
  }

  function dropIndex(clientY: number) {
    const rows = [...(listRef.current?.querySelectorAll<HTMLElement>("li[data-row]") ?? [])];
    const index = rows.findIndex((row) => { const box = row.getBoundingClientRect(); return clientY < box.top + box.height / 2; });
    return index === -1 ? rows.length : index;
  }
  function startDrag(event: PointerEvent<HTMLButtonElement>, item: ChecklistItem, index: number) {
    if (readOnly || event.button !== 0) return;
    event.currentTarget.setPointerCapture?.(event.pointerId);
    setDrag({ id: item.id, index });
  }
  function dragMove(event: PointerEvent<HTMLButtonElement>) {
    if (drag) setDrag({ ...drag, index: dropIndex(event.clientY) });
  }
  function endDrag() {
    if (!drag) return;
    const from = open.findIndex((item) => item.id === drag.id);
    const to = drag.index > from ? drag.index - 1 : drag.index;
    setDrag(null);
    if (from !== -1 && to !== from) onChange(placeInGroup(items, open, drag.id, to));
  }

  const row = (item: ChecklistItem, index: number, draggable: boolean) => (
    <li key={item.id} data-row={draggable ? "" : undefined} className={`notes-check${item.checked ? " is-checked" : ""}${drag?.id === item.id ? " is-dragging" : ""}${draggable && drag && drag.index === index && drag.id !== item.id ? " is-drop-target" : ""}`}>
      {draggable && !readOnly ? (
        <button type="button" className="notes-check__handle" aria-label="끌어서 순서 바꾸기" title="끌어서 순서 바꾸기 (Alt+↑/↓)" tabIndex={-1}
          onPointerDown={(event) => startDrag(event, item, index)} onPointerMove={dragMove} onPointerUp={endDrag} onPointerCancel={() => setDrag(null)}>
          <Bars3Icon aria-hidden="true" />
        </button>
      ) : <span className="notes-check__handle" aria-hidden="true" />}
      <input type="checkbox" checked={item.checked} disabled={readOnly} aria-label={`${item.text.trim() || "빈 항목"} 완료`} onChange={(event) => update(item.id, { checked: event.currentTarget.checked })} />
      <input className="notes-check__text" data-item-id={item.id} aria-label="체크리스트 항목" value={item.text} readOnly={readOnly} maxLength={NOTE_LIMITS.itemChars} placeholder="항목"
        onChange={(event) => update(item.id, { text: event.currentTarget.value.replace(/[\r\n]+/g, " ") })} onKeyDown={(event) => keyDown(event, item, index)} />
      {!readOnly && <button type="button" className="notes-check__remove" aria-label="항목 삭제" onClick={() => remove(item, false)}><XMarkIcon aria-hidden="true" /></button>}
    </li>
  );

  return (
    <div className="notes-checklist">
      <ul ref={listRef} className="notes-checklist__open" aria-label="할 일">
        {open.map((item, index) => row(item, index, true))}
        {drag && drag.index === open.length && <li className="notes-check__drop-end" aria-hidden="true" />}
      </ul>
      {!readOnly && (
        <button type="button" className="notes-checklist__add" disabled={items.length >= NOTE_LIMITS.items} onClick={() => insertAfter(open.length - 1)}>
          <PlusIcon aria-hidden="true" />항목 추가
        </button>
      )}
      {done.length > 0 && (
        <section className="notes-checklist__done">
          <button type="button" className="notes-checklist__done-toggle" aria-expanded={doneOpen} onClick={() => setDoneOpen(!doneOpen)}>
            {doneOpen ? <ChevronDownIcon aria-hidden="true" /> : <ChevronRightIcon aria-hidden="true" />}완료 {done.length}
          </button>
          {doneOpen && <ul aria-label="완료한 항목">{done.map((item, index) => row(item, index, false))}</ul>}
        </section>
      )}
    </div>
  );
}
