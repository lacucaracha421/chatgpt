/**
 * Mobile bookmark state for the catalog UI: the user's action, its durable
 * intent, and its delivery.
 *
 * The UI must never claim a state the server has not accepted. The visible value
 * is therefore the *intended* value with an explicit pending flag, and it loses
 * that flag only when the authority confirms the intent. A replica refresh that
 * carries older authority data is applied underneath a pending intent rather than
 * over it, because the intent is not authority state.
 */

import {useCallback, useEffect, useRef, useState} from 'react';
import {flushBookmarkIntents} from './bookmarkDelivery';
import {
  type BookmarkAuthority,
  commitBookmarkIntent,
  readIntent,
  readIntents,
  readConfirmed,
  recordConfirmed,
  visibleBookmark,
} from './bookmarkOutbox';
import {errorText} from './transport';

export const NO_AUTHORITY_MESSAGE = '서버에서 북마크 저장을 아직 사용할 수 없습니다.';

/**
 * Durable bookmark intents for the catalog.
 *
 * `authority` is non-null only when the server owns the domain *and* advertises
 * `bookmarkWrite`; until then the UI offers no toggle and nothing is sent, while
 * any intent already queued stays durable. The caller owns the authority value
 * because it reads the advertisement from the same `/status` check that drives
 * its publication refresh.
 */
export function useBookmarks({active, authority}: {active: boolean; authority: BookmarkAuthority | null}) {
  const [intents, setIntents] = useState(readIntents);
  const [confirmed, setConfirmed] = useState(readConfirmed);
  const [failure, setFailure] = useState('');
  const flushing = useRef(false);
  const mounted = useRef(true);
  const scope = useRef<BookmarkAuthority | null>(authority);
  scope.current = authority;
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);

  // Re-read durable state when the screen becomes active, so a restart is
  // reflected instead of being held in memory only.
  useEffect(() => { if (active) { setIntents(readIntents()); setConfirmed(readConfirmed()); } }, [active]);

  /** Send everything durable, then publish the settled state. */
  const flush = useCallback(async () => {
    if (flushing.current) return;
    flushing.current = true;
    try {
      const report = await flushBookmarkIntents();
      if (!mounted.current) return;
      setFailure(report.authorityUnavailable && report.outcomes.length > 0 ? NO_AUTHORITY_MESSAGE : '');
    } catch (error) {
      // A retryable failure keeps the intent durable; only the message differs.
      if (mounted.current) setFailure(errorText(error));
    } finally {
      flushing.current = false;
      if (mounted.current) { setIntents(readIntents()); setConfirmed(readConfirmed()); }
    }
  }, []);

  /**
   * Apply the user's bookmark action.
   *
   * The durable intent commits before any HTTP attempt, so the visible state
   * cannot survive a crash without its outgoing operation. The round trip is
   * deliberately not awaited: the UI reflects the intent at once and marks it
   * pending until the authority confirms it.
   */
  const toggle = useCallback((provider: 'kHentai', providerWorkId: string, desired: boolean) => {
    const current = scope.current;
    if (!current) { setFailure(NO_AUTHORITY_MESSAGE); return; }
    commitBookmarkIntent(provider, providerWorkId, desired, current);
    setIntents(readIntents());
    setFailure('');
    void flush();
  }, [flush]);

  /**
   * The visible state for one work: the authoritative value under any pending
   * intent, with `observedRevision` letting a confirmed write outrank a read the
   * screen made before it.
   */
  const stateFor = useCallback(
    (provider: string, providerWorkId: string, authoritative: boolean | null, observedRevision?: number) =>
      visibleBookmark(provider, providerWorkId, authoritative, observedRevision),
    // `intents` and `confirmed` are the durable counters for this projection.
    [intents, confirmed],
  );

  /** Record an authoritative observation read through the existing detail path. */
  const observe = useCallback((provider: string, providerWorkId: string, revision: number, desired: boolean) => {
    const current = scope.current;
    // An observation from a different authority is not this queue's baseline.
    if (!current) return;
    recordConfirmed(provider, providerWorkId, current.epoch, revision, desired);
    setConfirmed(readConfirmed());
  }, []);

  const hasPending = useCallback((provider: string, providerWorkId: string) => readIntent(provider, providerWorkId) !== null, [intents]);

  return {failure, flush, toggle, stateFor, observe, hasPending};
}

/**
 * Retry scheduling shared by the catalog: pending work is retried while the view
 * is visible, and immediately when the app returns to the foreground.
 */
export function usePendingRetry(active: boolean, pending: boolean, flush: () => Promise<void>) {
  const latest = useRef(flush);
  latest.current = flush;
  useEffect(() => {
    if (!active || !pending) return;
    const resume = () => { void latest.current(); };
    const timer = setInterval(resume, 30_000);
    window.addEventListener('lakomics-resume', resume);
    document.addEventListener('visibilitychange', resume);
    return () => {
      clearInterval(timer);
      window.removeEventListener('lakomics-resume', resume);
      document.removeEventListener('visibilitychange', resume);
    };
  }, [active, pending]);
}
