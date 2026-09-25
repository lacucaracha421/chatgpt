import {onVisible} from './useVisibleInterval';
/**
 * Personal Collection edits for the UI: the queued value shows at once with a
 * pending mark, delivery runs after each edit, and retries follow the bookmark
 * schedule (every 30 s while pending and visible, and on returning to the app).
 * `notice` briefly explains an edit that was not kept: the device could not store
 * it, or the server refused it for good and the value went back.
 */

import {useCallback, useEffect, useRef, useState} from 'react';
import {usePendingRetry} from './useBookmarks';
import {flushCollectionEdits, personalEditLibrary, trackingEditAllowed, type CollectionEditStatus} from './collectionEditDelivery';
import {
  COLLECTION_EDITS_EVENT,
  type CollectionEditField,
  type CollectionEditValue,
  collectionEditKey,
  commitCollectionEdit,
  readCollectionEdits,
  resolveCollectionEditConflict,
  sameEditValue,
} from './collectionEditOutbox';
import {errorText} from './transport';

const NOTICE_MS = 5000;

export function useCollectionEdits({active, onSettled}: {active: boolean; onSettled(): void}) {
  const [intents, setIntents] = useState(readCollectionEdits);
  const [supported, setSupported] = useState(false);
  /** 신간 알림 / owned volumes: the server advertises `collectionTrackingEdit` (a version-2 PC). */
  const [trackingSupported, setTrackingSupported] = useState(false);
  const [failure, setFailure] = useState('');
  const [notice, setNotice] = useState('');
  /**
   * Values the server just confirmed, kept until the screen's own copy catches up. Between the
   * confirmation (the intent leaves the queue) and the refreshed detail, the screen still holds
   * the pre-edit value; without this the control would flip back and then forward again.
   */
  const [confirmed, setConfirmed] = useState<Record<string, {value: CollectionEditValue; expected: CollectionEditValue}>>({});
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
      const before = readCollectionEdits();
      const report = await flushCollectionEdits();
      if (!mounted.current) return;
      const accepted = report.outcomes.filter(({key, outcome}) => (outcome === 'confirmed' || outcome === 'already-current') && before[key]);
      if (accepted.length) setConfirmed(current => {
        const next = {...current};
        for (const {key} of accepted) next[key] = {value: before[key].value, expected: before[key].expected};
        return next;
      });
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
    setTrackingSupported(trackingEditAllowed(reply as CollectionEditStatus));
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
    const key = collectionEditKey(collectionId, field, authoritative);
    const intent = intents[key];
    if (intent) return {value: intent.value as T, pending: true, conflict: intent.conflict ? {current: intent.conflict.current} : null};
    // Confirmed but not yet re-read: show the confirmed value while the screen still holds the
    // exact pre-edit value. Any other value (the refresh, or a later PC change) wins.
    const settledValue = confirmed[key];
    if (settledValue && sameEditValue(authoritative, settledValue.expected) && !sameEditValue(authoritative, settledValue.value))
      return {value: settledValue.value as T, pending: false, conflict: null};
    return {value: authoritative, pending: false, conflict: null};
  }, [intents, confirmed]);

  const pending = Object.values(intents).some(intent => !intent.conflict);
  usePendingRetry(active, pending, flush);

  return {supported, trackingSupported, failure, notice, edit, resolveConflict, visible, observeStatus, flush};
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
    const removeVisible=onVisible(send);
    return () => { removeVisible(); };
  }, [enabled]);
}
