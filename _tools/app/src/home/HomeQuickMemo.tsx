import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import type { NotesStore } from "../notes/store";
import { SectionLabel } from "../shared/ui/SectionLabel";
import { Button } from "../shared/ui/Button";
import { findQuickMemo, newQuickMemo, readQuickMemoId, writeQuickMemoId } from "./quickMemo";
import "./homeTools.css";

export const QUICK_MEMO_SAVE_DELAY = 800;
const noopSubscribe = () => () => undefined;
const EMPTY = { ready: false, unlocked: false, notes: [], lastSyncedAt: null, saving: false, syncing: false, error: null } as ReturnType<NotesStore["snapshot"]>;
const emptySnapshot = () => EMPTY;

type Props = {
  store: NotesStore | null;
  root: string;
  /** Quiet time after the last key before the text is saved. */
  delay?: number;
  /** Opens the 메모 tab (to set the notes up, or to read a hidden note). */
  onOpenNotes: () => void;
};

/**
 * One text note, "빠른 메모", edited in place. The text saves by itself through the notes store, which owns
 * revisions and edit collisions; the 메모 tab shows the same note.
 */
export function HomeQuickMemo({ store, root, delay = QUICK_MEMO_SAVE_DELAY, onOpenNotes }: Props) {
  const state = useSyncExternalStore(store?.subscribe ?? noopSubscribe, store?.snapshot ?? emptySnapshot);
  const savedId = useRef<{ root: string; id: string | null }>({ root, id: readQuickMemoId(root) });
  if (savedId.current.root !== root) savedId.current = { root, id: readQuickMemoId(root) };
  const note = findQuickMemo(state.notes, savedId.current.id);
  const [draft, setDraft] = useState<string | null>(null);
  const draftRef = useRef<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);

  // The id is remembered once a note is found by its title, so the next start does not depend on the title.
  useEffect(() => {
    if (note && note.id !== savedId.current.id) { savedId.current = { root, id: note.id }; writeQuickMemoId(root, note.id); }
  }, [note, root]);
  // A stale save that could not merge was kept as a copy: keep typing in the copy, like the 메모 tab.
  useEffect(() => {
    if (state.moved && state.moved.from === savedId.current.id) {
      savedId.current = { root, id: state.moved.to };
      writeQuickMemoId(root, state.moved.to);
      store?.clearMoved();
    }
  }, [state.moved, store, root]);

  function save() {
    clearTimeout(timer.current);
    timer.current = undefined;
    const value = draftRef.current;
    if (value === null || !store) return;
    const current = findQuickMemo(store.snapshot().notes, savedId.current.id);
    if (current) {
      if (current.body !== value) store.edit({ ...current, body: value }, true);
    } else if (value !== "") {
      // Created on first use.
      const fresh = newQuickMemo(value);
      savedId.current = { root, id: fresh.id };
      writeQuickMemoId(root, fresh.id);
      store.edit(fresh, true);
    }
    // Keys typed while saving keep their draft.
    if (draftRef.current === value) { draftRef.current = null; setDraft(null); }
  }
  const saveRef = useRef(save);
  useLayoutEffect(() => { saveRef.current = save; });
  // Leaving Home saves what is typed and lets the notes sync once, like closing a note in the 메모 tab.
  useEffect(() => () => { saveRef.current(); void store?.finish(); }, [store]);

  const change = (value: string) => {
    draftRef.current = value;
    setDraft(value);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => saveRef.current(), delay);
  };
  const finish = () => { save(); void store?.finish(); };

  const unavailable = !store || !state.ready ? "loading" : !state.unlocked || state.keyringLocked ? "locked" : note && (note.concealed || note.readOnly) ? "hidden" : null;
  const shown = draft ?? note?.body ?? "";
  return <section className="home-attention-section home-tool home-qmemo" aria-label="빠른 메모">
    <SectionLabel title="빠른 메모" />
    <div className="home-tool__body">
      <textarea className="ui-text-input home-qmemo__text" rows={8} spellCheck={false} aria-label="빠른 메모" placeholder="빠른 메모" value={shown} disabled={unavailable !== null}
        onChange={event => change(event.target.value)} onBlur={finish} />
      {(unavailable === "locked" || unavailable === "hidden") && <div className="home-qmemo__status" role="status">
        <span>{unavailable === "locked" ? "메모를 열어야 쓸 수 있습니다" : "숨긴 메모입니다"}</span>
        <Button variant="quiet" size="sm" onClick={onOpenNotes}>메모 열기</Button>
      </div>}
      {!unavailable && note?.conflict && <div className="home-qmemo__status" role="status">
        <span>다른 기기 수정과 충돌했습니다.</span>
        <Button variant="quiet" size="sm" disabled={state.syncing || state.saving || draft !== null} onClick={() => void store?.resolve(note, true)}>내 내용 보관 후 서버 버전 불러오기</Button>
      </div>}
      {!unavailable && !note?.conflict && state.error && note?.pending && <p className="home-qmemo__status" role="status">{state.error}</p>}
    </div>
  </section>;
}
