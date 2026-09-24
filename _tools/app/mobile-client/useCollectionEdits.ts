/**
 * Personal Collection edits for the UI: the queued value shows at once with a
 * pending mark, delivery runs after each edit, and retries follow the bookmark
 * schedule (every 30 s while pending and visible, and on returning to the app).
 * `notice` briefly explains an edit that was not kept: the device could not store
 * it, or the server refused it for good and the value went back.
 */

import {useCallback, useEffect, useRef, useState} from 'react';
import {usePendingRetry} from './useBookmarks';
import {flushCollectionEdits, personalEditLibrary, type CollectionEditStatus} from './collectionEditDelivery';
import {
  COLLECTION_EDITS_EVENT,
  type CollectionEditField,
  type CollectionEditValue,
  collectionEditKey,
  commitCollectionEdit,
  readCollectionEdits,
  resolveCollectionEditConflict,
} from './collectionEditOutbox';
import {errorText} from './transport';

const NOTICE_MS = 5000;

export function useCollectionEdits({active, onSettled}: {active: boolean; onSettled(): void}) {
  const [intents, setIntents] = useState(readCollectionEdits);
  const [supported, setSupported] = useState(false);
  const [failure, setFailure] = useState('');
  const [notice, setNotice] = useState('');
  const mounted = useRef(true);
  const settled = useRef(onSettled);
  settled.current = onSettled;
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => {
    const read = () => { if (mounted.current) setIntents(readCollectionEdits()); };
    window.addEventListener(COLLECTION_EDITS_EVENT, read);
    return () => window.removeEventListener(COLLECTION_EDITS_EVENT, read);
  }, []);
  useEffect(() => { if (active) setIntents(readCollectionEdits()); }, [active]);
  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(''), NOTICE_MS);
    return () => window.clearTimeout(timer);
  }, [notice]);

  const flush = useCallback(async () => {
    try {
      const report = await flushCollectionEdits();
      if (!mounted.current) return;
      // Waiting for a PC/server upgrade is not an error; the value stays "전송 대기".
      setFailure(report.error ? errorText(report.error) : '');
      const rejected = report.outcomes.find(({outcome, message}) => outcome === 'rejected' && message);
      if (rejected?.message) setNotice(rejected.message);
      if (report.outcomes.some(({outcome}) => outcome === 'confirmed' || outcome === 'already-current' || outcome === 'rejected')) settled.current();
    } catch (error) {
      if (mounted.current) setFailure(errorText(error));
    } finally {
      if (mounted.current) setIntents(readCollectionEdits());
    }
  }, []);

  /** Take the capability from the Collection `/status` check the screen already runs. */
  const observeStatus = useCallback((reply: unknown) => {
    setSupported(personalEditLibrary(reply as CollectionEditStatus) !== null);
  }, []);

  const edit = useCallback((collectionId: string, field: CollectionEditField, value: CollectionEditValue, authoritative: CollectionEditValue) => {
    try {
      commitCollectionEdit(collectionId, field, value, authoritative);
    } catch (error) {
      // Not stored, so not queued: say so instead of showing it as 전송 대기.
      setNotice(errorText(error));
      setIntents(readCollectionEdits());
      return;
    }
    setIntents(readCollectionEdits());
    setFailure('');
    setNotice('');
    void flush();
  }, [flush]);

  const resolveConflict = useCallback((collectionId: string, field: CollectionEditField, choice: 'overwrite' | 'discard') => {
    resolveCollectionEditConflict(collectionId, field, choice);
    setIntents(readCollectionEdits());
    if (choice === 'overwrite') void flush();
  }, [flush]);

  const visible = useCallback(<T extends CollectionEditValue>(collectionId: string, field: CollectionEditField, authoritative: T) => {
    const intent = intents[collectionEditKey(collectionId, field)];
    return intent
      ? {value: intent.value as T, pending: true, conflict: intent.conflict ? {current: intent.conflict.current} : null}
      : {value: authoritative, pending: false, conflict: null};
  }, [intents]);

  const pending = Object.values(intents).some(intent => !intent.conflict);
  usePendingRetry(active, pending, flush);

  return {supported, failure, notice, edit, resolveConflict, visible, observeStatus, flush};
}

/** App-level delivery: on start and on returning to the foreground, whatever screen is open. */
export function useCollectionEditBackgroundFlush(enabled: boolean) {
  useEffect(() => {
    if (!enabled) return;
    const send = () => {
      if (document.visibilityState === 'hidden') return;
      if (Object.values(readCollectionEdits()).some(intent => !intent.conflict)) void flushCollectionEdits().catch(() => {});
    };
    send();
    window.addEventListener('lakomics-resume', send);
    document.addEventListener('visibilitychange', send);
    return () => { window.removeEventListener('lakomics-resume', send); document.removeEventListener('visibilitychange', send); };
  }, [enabled]);
}
