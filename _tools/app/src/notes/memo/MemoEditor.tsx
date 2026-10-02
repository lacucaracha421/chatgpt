import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';
import { ArrowsRightLeftIcon } from '@heroicons/react/24/outline';
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import { Button } from '../../shared/ui/Button';
import { Dialog } from '../../shared/ui/Dialog';
import { Menu, type MenuItem } from '../../shared/ui/Menu';
import { appendToSection, deleteMemoSection, editItem, joinItem, makeSection, memoBody, memoMode, memoSections, moveItem, moveMemoSection, moveMemoSectionTo, parseMemo, pasteItems, renameMemoSection, sectionCopy, splitItem, toggleItem, unmakeSection, type MemoDocument, type MemoItem } from './memoModel';
import { useMemoSectionDrag } from './useMemoSectionDrag';
import './memo.css';

export type MemoEditorProps = {
  noteId: string;
  body: string;
  touch?: boolean;
  readOnly?: boolean;
  /** Reveal an externally appended row without moving focus from the quick input. */
  revealItem?: { line: number; key: number };
  /** Return false if the existing note limits reject the edit. */
  onChange: (body: string, structural: boolean) => boolean | void;
  copyText?: (text: string) => Promise<void>;
  /** Tablet back gesture: the editor sets a handler that closes its own dialog/menu/rename first (true = handled). */
  backRef?: { current: (() => boolean) | null };
};
const defaultCopy = (text: string) => navigator.clipboard.writeText(text);
export const MEMO_HOLD_MS = 550;

function sizeArea(area: HTMLTextAreaElement) {
  // scrollHeight works in WebKitGTK, WebView2 and Android WebView, including wrapped lines.
  area.style.height = '0px';
  const style = getComputedStyle(area);
  const border = (parseFloat(style.borderTopWidth) || 0) + (parseFloat(style.borderBottomWidth) || 0);
  area.style.height = `${Math.max(area.scrollHeight + border, parseFloat(style.lineHeight) || 24)}px`;
}
function ItemArea({ item, readOnly, onEdit, onKey, onPaste, register }: {
  item: MemoItem; readOnly: boolean; onEdit: (text: string) => boolean | void;
  onKey: (event: KeyboardEvent<HTMLTextAreaElement>) => void;
  onPaste: (start: number, end: number, text: string) => void;
  register: (node: HTMLTextAreaElement | null) => void;
}) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const composing = useRef(false);
  const commit = useRef(item.text);
  useLayoutEffect(() => {
    const area = ref.current; if (!area || composing.current) return;
    if (area.value !== item.text) area.value = item.text;
    commit.current = item.text;
    sizeArea(area);
  }, [item.text]);
  useLayoutEffect(() => {
    const area = ref.current; if (!area) return;
    register(area);
    let width = area.getBoundingClientRect().width;
    const resize = () => sizeArea(area);
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(() => {
      const next = area.getBoundingClientRect().width;
      if (next !== width) { width = next; resize(); }
    });
    observer?.observe(area); window.addEventListener('resize', resize); document.fonts?.addEventListener('loadingdone', resize);
    return () => { register(null); observer?.disconnect(); window.removeEventListener('resize', resize); document.fonts?.removeEventListener('loadingdone', resize); };
  }, []);
  function save(area: HTMLTextAreaElement) {
    sizeArea(area);
    if (commit.current === area.value) return;
    commit.current = area.value;
    if (onEdit(area.value) === false) { area.value = item.text; commit.current = item.text; sizeArea(area); }
  }
  return <textarea ref={ref} className="memo-item-text" data-memo-item={item.id} aria-label="메모 본문" defaultValue={item.text} rows={1} spellCheck={false} readOnly={readOnly}
    onChange={event => { sizeArea(event.currentTarget); if (!composing.current && !(event.nativeEvent as InputEvent).isComposing) save(event.currentTarget); }}
    onCompositionStart={() => { composing.current = true; }}
    onCompositionEnd={event => { composing.current = false; save(event.currentTarget); }}
    onBlur={event => { if (!composing.current) save(event.currentTarget); }}
    onKeyDown={event => { if (!composing.current && !event.nativeEvent.isComposing && event.keyCode !== 229 && !readOnly) onKey(event); }}
    onPaste={event => {
      if (readOnly || composing.current) return;
      const text = event.clipboardData.getData('text/plain');
      if (!/[\r\n]/.test(text)) return;
      event.preventDefault(); onPaste(event.currentTarget.selectionStart, event.currentTarget.selectionEnd, text);
    }}/>
}

export function MemoEditor({ noteId, body, touch = false, readOnly = false, revealItem, onChange, copyText = defaultCopy, backRef }: MemoEditorProps) {
  const mode = memoMode(body);
  const documentRef = useRef<{ id: string; doc: MemoDocument }>({ id: noteId, doc: parseMemo(body) });
  const [filter, setFilter] = useState<string | null>(null);
  const [doneOpen, setDoneOpen] = useState<Set<string>>(new Set());
  const [rename, setRename] = useState<string | null>(null);
  const renamingComposition = useRef(false);
  const [deleteTarget, setDeleteTarget] = useState<string | null>(null);
  const [moveMenu, setMoveMenu] = useState<string | null>(null);
  const [sectionMenu, setSectionMenu] = useState<string | null>(null);
  useEffect(() => {
    if (!backRef) return;
    backRef.current = () => {
      if (deleteTarget) { setDeleteTarget(null); return true; }
      if (moveMenu) { setMoveMenu(null); return true; }
      if (sectionMenu) { setSectionMenu(null); return true; }
      if (rename) { setRename(null); return true; }
      return false;
    };
    return () => { backRef.current = null; };
  });
  const [status, setStatus] = useState<{ id: string; text: string } | null>(null);
  const statusTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const root = useRef<HTMLDivElement>(null);
  const areas = useRef(new Map<string, HTMLTextAreaElement>());
  const focusTarget = useRef<{ id: string; at: number } | null>(null);
  const revealTarget = useRef<string | null>(null);
  const opened = useRef<string | null>(null);
  const hold = useRef<{ timer: ReturnType<typeof setTimeout>; x: number; y: number } | null>(null);
  // Replace directly with ready content; there is no empty loading frame between notes or saves.
  if (documentRef.current.id !== noteId) {
    cancelHold(); clearTimeout(statusTimer.current); focusTarget.current = null;
    revealTarget.current = null; renamingComposition.current = false;
    documentRef.current = { id: noteId, doc: parseMemo(body) };
    setFilter(null); setDoneOpen(new Set()); setRename(null); setDeleteTarget(null); setMoveMenu(null); setSectionMenu(null); setStatus(null);
  } else if (memoBody(documentRef.current.doc) !== body) {
    documentRef.current.doc = parseMemo(body, documentRef.current.doc);
  }
  const doc = documentRef.current.doc;
  const sections = memoSections(doc);
  const named = sections.filter(section => section.heading);
  const tasks = (items: MemoItem[]) => mode === 'todo' ? items.filter(item => item.task) : items;
  const activeFilter = named.some(section => section.id === filter) ? filter : null;
  const shown = sections.filter(section => (!activeFilter || section.id === activeFilter) && (section.heading || section.items.length));
  const visible = shown.flatMap(section => mode === 'todo' ? [...tasks(section.items).filter(item => !item.done), ...(doneOpen.has(section.id) ? tasks(section.items).filter(item => item.done) : [])] : section.items);
  const canDrag = !readOnly && !activeFilter && named.length > 1 && !rename;
  const sectionDrag = useMemoSectionDrag(root, canDrag, `${noteId}:${body}`, (id, index) => apply(moveMemoSectionTo(documentRef.current.doc, id, index)));
  useLayoutEffect(() => {
    if (!revealItem) return;
    const item = sections.flatMap(section => section.items).find(item => item.id === doc.lines[revealItem.line]?.id);
    if (!item) return;
    revealTarget.current = item.id;
    if (activeFilter && activeFilter !== item.sectionId) setFilter(item.sectionId === 'top' ? null : item.sectionId);
  }, [noteId, revealItem]);
  useLayoutEffect(() => {
    const area = revealTarget.current ? areas.current.get(revealTarget.current) : null;
    if (!area) return;
    revealTarget.current = null;
    area.scrollIntoView?.({ block: 'nearest' });
  });
  function focus(id: string, at = Number.MAX_SAFE_INTEGER) { focusTarget.current = { id, at }; }
  useLayoutEffect(() => {
    if (opened.current !== noteId) {
      opened.current = noteId;
      const last = [...visible].reverse().find(item => mode !== 'todo' || !item.done);
      focus(last?.id ?? '');
    }
    const target = focusTarget.current; if (!target) return;
    if (!target.id) { focusTarget.current = null; (root.current?.querySelector<HTMLButtonElement>('.memo-add') ?? root.current)?.focus(); return; }
    const area = areas.current.get(target.id); if (!area) { focusTarget.current = null; root.current?.focus(); return; }
    focusTarget.current = null; area.focus();
    const at = Math.min(target.at, area.value.length); area.setSelectionRange(at, at);
  });
  useEffect(() => () => { clearTimeout(statusTimer.current); cancelHold(); }, []);
  function cancelHold() { if (hold.current) clearTimeout(hold.current.timer); hold.current = null; }
  function apply(next: MemoDocument, structural = true) {
    if (readOnly) return false;
    if (memoBody(next) === body) return true;
    const previous = documentRef.current.doc;
    documentRef.current.doc = next;
    if (onChange(memoBody(next), structural) === false) { documentRef.current.doc = previous; focusTarget.current = null; return false; }
    return true;
  }
  function key(event: KeyboardEvent<HTMLTextAreaElement>, item: MemoItem) {
    const area = event.currentTarget; const start = area.selectionStart, end = area.selectionEnd;
    if (event.key === 'Enter') {
      event.preventDefault();
      const next = splitItem(doc, item.id, start, end, mode);
      focus(`line-${doc.nextId}`, 0); apply(next);
    } else if (event.key === 'Backspace' && start === 0 && end === 0) {
      event.preventDefault();
      const section = sections.find(section => section.id === item.sectionId)!;
      const peers = tasks(section.items).filter(candidate => mode !== 'todo' || candidate.done === item.done);
      const index = peers.findIndex(candidate => candidate.id === item.id);
      const previous = peers[index - 1];
      if (!previous) return;
      focus(previous.id, previous.text.length); apply(joinItem(doc, item.id, mode));
    } else if ((event.key === 'ArrowUp' && start === 0 && end === 0) || (event.key === 'ArrowDown' && start === area.value.length && start === end)) {
      const index = visible.findIndex(candidate => candidate.id === item.id);
      const next = visible[index + (event.key === 'ArrowUp' ? -1 : 1)];
      if (!next) return;
      event.preventDefault(); const field = areas.current.get(next.id);
      field?.focus(); const at = event.key === 'ArrowUp' ? field?.value.length ?? 0 : 0; field?.setSelectionRange(at, at);
    }
  }
  function row(item: MemoItem) {
    const targets = sections.filter(section => section.id !== item.sectionId && (section.heading || section.items.length));
    const moveContent = <>
      {targets.map(section => <DropdownMenu.Item className="ui-menu__item" key={section.id} onSelect={() => { focus(activeFilter || item.done ? '' : item.id); apply(moveItem(doc, item.id, section.id, mode)); }}>{section.title ?? '제목 없음'}</DropdownMenu.Item>)}
      <DropdownMenu.Separator className="memo-menu-separator"/>
      <DropdownMenu.Item className="ui-menu__item" onSelect={() => { focus(''); apply(makeSection(doc, item.id)); setFilter(null); }}>섹션으로 만들기</DropdownMenu.Item>
    </>;
    function pointerDown(event: PointerEvent<HTMLDivElement>) {
      if (!touch || readOnly || (event.target as HTMLElement).closest('button') || event.button !== 0) return;
      cancelHold(); hold.current = { x: event.clientX, y: event.clientY, timer: setTimeout(() => { hold.current = null; setMoveMenu(item.id); }, MEMO_HOLD_MS) };
    }
    return <div className={`memo-item${mode === 'todo' && item.done ? ' is-done' : ''}`} key={item.id}
      onPointerDown={pointerDown} onPointerUp={cancelHold} onPointerCancel={cancelHold}
      onContextMenu={event => { if (touch && !readOnly) { event.preventDefault(); cancelHold(); setMoveMenu(item.id); } }}
      onPointerMove={event => { if (hold.current && Math.hypot(event.clientX - hold.current.x, event.clientY - hold.current.y) > 8) cancelHold(); }}>
      {mode === 'todo' && <button type="button" className="memo-tick" aria-label={item.done ? '완료 취소' : '완료'} aria-pressed={item.done} disabled={readOnly} onClick={() => {
        if (!item.done) { const peers = visible.filter(candidate => candidate.id !== item.id && !candidate.done); const index = visible.findIndex(candidate => candidate.id === item.id); focus(peers.find(candidate => visible.indexOf(candidate) > index)?.id ?? peers[peers.length - 1]?.id ?? ''); }
        else focus(item.id);
        apply(toggleItem(doc, item.id));
      }}/>}
      <ItemArea item={item} readOnly={readOnly} register={node => { if (node) areas.current.set(item.id, node); else areas.current.delete(item.id); }}
        onEdit={text => apply(editItem(documentRef.current.doc, item.id, text, mode), false)} onKey={event => key(event, item)}
        onPaste={(start, end, text) => {
          const next = pasteItems(doc, item.id, start, end, text, mode);
          const parts = text.split(/\r\n|\r|\n/);
          const id = parts.length > 1 ? `line-${next.nextId - 1}` : item.id;
          focus(id, Number.MAX_SAFE_INTEGER); apply(next);
        }}/>
      {!readOnly && <Menu label="다른 섹션으로 옮기기" trigger={<ArrowsRightLeftIcon aria-hidden="true"/>} triggerClassName={`memo-move${touch ? ' memo-move--touch' : ''}`} open={moveMenu === item.id} onOpenChange={open => setMoveMenu(open ? item.id : null)} content={moveContent}/>}
    </div>;
  }
  return <div ref={root} tabIndex={-1} className={`memo-editor${touch ? ' memo-editor--touch' : ''}${sectionDrag.dragged ? ' memo-editor--dragging' : ''}`} onPointerDownCapture={sectionDrag.resetClick} onClickCapture={sectionDrag.clickCapture}>
    {named.length >= 2 && <div className="memo-chips" aria-label="메모 섹션">
      <button type="button" aria-label={mode === 'todo' ? `전체 ${sections.reduce((total, section) => total + tasks(section.items).filter(item => !item.done).length, 0)}` : '전체'} aria-pressed={!activeFilter} onClick={() => setFilter(null)}>전체{mode === 'todo' && <small> {sections.reduce((total, section) => total + tasks(section.items).filter(item => !item.done).length, 0)}</small>}</button>
      {named.map(section => <button key={section.id} type="button" aria-label={`${section.title || '제목 없음'}${mode === 'todo' ? ` ${tasks(section.items).filter(item => !item.done).length}` : ''}`} aria-pressed={activeFilter === section.id} onClick={() => setFilter(section.id)}>{section.title || '제목 없음'}{mode === 'todo' && <small> {tasks(section.items).filter(item => !item.done).length}</small>}</button>)}
    </div>}
    {shown.map(section => {
      const open = tasks(section.items).filter(item => !item.done), done = tasks(section.items).filter(item => item.done);
      const index = named.findIndex(candidate => candidate.id === section.id);
      const sectionActions: MenuItem[] = [
        { id: 'rename', label: '이름 바꾸기', onSelect: () => setRename(section.id) },
        { id: 'up', label: '위로', disabled: index === 0, onSelect: () => apply(moveMemoSection(doc, section.id, 'up')) },
        { id: 'down', label: '아래로', disabled: index === named.length - 1, onSelect: () => apply(moveMemoSection(doc, section.id, 'down')) },
        { id: 'unmake', label: '섹션 풀기', onSelect: () => apply(unmakeSection(doc, section.id, mode)) },
        { id: 'delete', label: '섹션 삭제', destructive: true, onSelect: () => setDeleteTarget(section.id) },
      ];
      return <section className={`memo-section${sectionDrag.dragged === section.id ? ' memo-section--dragging' : ''}`} key={`${noteId}:${section.id}`}
        data-memo-section={section.heading ? section.id : undefined} style={sectionDrag.style(section.id)}>
        {section.heading && <div className={`memo-section-head${canDrag ? ' memo-section-head--draggable' : ''}`}
          onPointerDownCapture={event => {
            sectionDrag.pointerDown(event, section.id);
            // Radix normally opens on pointer-down. Defer this row's menu to click,
            // allowing its button to participate in the same threshold/hold gesture.
            if ((event.target as Element).closest('.ui-menu__trigger')) event.stopPropagation();
          }}
          onClick={event => { if ((event.target as Element).closest('.ui-menu__trigger')) setSectionMenu(current => current === section.id ? null : section.id); }}
          onContextMenu={event => { if (sectionDrag.dragged) event.preventDefault(); }}>
          {canDrag && <span className="memo-section-grip" aria-hidden="true">⠿</span>}
          {rename === section.id && !readOnly ? <input className="memo-rename" aria-label="섹션 이름" autoFocus defaultValue={section.title ?? ''}
            onCompositionStart={() => { renamingComposition.current = true; }}
            onCompositionEnd={event => {
              renamingComposition.current = false;
              if (document.activeElement !== event.currentTarget) { apply(renameMemoSection(documentRef.current.doc, section.id, event.currentTarget.value)); setRename(null); }
            }}
            onBlur={event => { if (renamingComposition.current) return; apply(renameMemoSection(documentRef.current.doc, section.id, event.currentTarget.value)); setRename(null); }} onKeyDown={event => {
            if (renamingComposition.current || event.nativeEvent.isComposing || event.keyCode === 229) return;
            if (event.key === 'Enter') { event.preventDefault(); event.currentTarget.blur(); }
            if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); setRename(null); }
          }}/> : <h2>{section.title || '제목 없음'}</h2>}
          {mode === 'todo' && <small>{open.length}개 남음</small>}
          {!readOnly && <><Button variant="quiet" onClick={async () => {
            try { await copyText(sectionCopy(section, mode)); if (documentRef.current.id !== noteId) return; setStatus({ id: section.id, text: '복사됨' }); } catch { if (documentRef.current.id !== noteId) return; setStatus({ id: section.id, text: '복사하지 못했습니다.' }); }
            clearTimeout(statusTimer.current); statusTimer.current = setTimeout(() => setStatus(null), 2200);
          }}>복사</Button><Menu label={`${section.title || '제목 없음'} 더보기`} items={sectionActions} trigger="⋯" open={sectionMenu === section.id} onOpenChange={open => setSectionMenu(open ? section.id : null)}/>{status?.id === section.id && <span className="memo-status" role="status">{status.text}</span>}</>}
        </div>}
        {(mode === 'todo' ? open : section.items).map(row)}
        {!readOnly && <button className="memo-add" type="button" onClick={() => {
          const next = appendToSection(doc, section.id, '', mode); focus(next.nextId > doc.nextId ? `line-${doc.nextId}` : next.lines[0]!.id, 0); apply(next);
        }} aria-label={mode === 'todo' ? '항목 추가' : '줄 추가'} title={mode === 'todo' ? '항목 추가' : '줄 추가'}>+</button>}
        {mode === 'todo' && done.length > 0 && <button className="memo-done-fold" type="button" aria-expanded={doneOpen.has(section.id)} onClick={() => setDoneOpen(current => { const next = new Set(current); if (next.has(section.id)) next.delete(section.id); else next.add(section.id); return next; })}>{doneOpen.has(section.id) ? '▾' : '▸'} 완료 {done.length}</button>}
        {mode === 'todo' && doneOpen.has(section.id) && done.map(row)}
      </section>;
    })}
    {sectionDrag.indicator !== undefined && <div className="memo-section-drop" aria-hidden="true" style={{ top: sectionDrag.indicator }}/>}
    {deleteTarget && <Dialog open title="섹션 삭제" onClose={() => setDeleteTarget(null)}><p>이 섹션과 항목을 삭제할까요?</p><div className="ui-dialog__actions"><Button variant="ghost" onClick={() => setDeleteTarget(null)}>취소</Button><Button variant="danger" onClick={() => { focus(''); apply(deleteMemoSection(doc, deleteTarget)); setDeleteTarget(null); }}>삭제</Button></div></Dialog>}
  </div>;
}
