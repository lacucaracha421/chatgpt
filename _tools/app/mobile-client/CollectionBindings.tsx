import {useEffect, useRef, useState, type FormEvent} from 'react';
import {createPortal} from 'react-dom';
import {CheckIcon, ChevronDownIcon, ChevronRightIcon, LinkIcon, MagnifyingGlassIcon, RectangleStackIcon} from '@heroicons/react/24/outline';
import {Button, Dialog, DialogDescription} from './ui';
import {ApiError, api, errorText} from './transport';
import {visibleInterval} from './useVisibleInterval';
import {SIGNAL_FALLBACK_MS, useSyncSignal} from './syncSignals';
import type {CollectionDetail} from './collectionModel';
import {
  BINDINGS_STATUS_PATH, MAX_KAKAO_GROUPS, PROVIDER_NAMES, chosenSummary, connectionOf, fileBindRequest, kakaoCommand, kakaoVolumes, latestRequest,
  mangaDexCommand, mangaDexStatus, mergeSummary, orderGroups, requestFailure, requestsPath, safeImageUrl, searchFailure, searchPath,
  type BindFailure, type BindProvider, type BindRequest, type BindStatus, type Connection, type KakaoCandidate, type MangaDexCandidate,
  type RequestsReply, type SearchReply,
} from './collectionBindings';
import './collectionBindings.css';

const PROVIDERS: BindProvider[] = ['mangadex', 'kakao'];
export const PUBLISHER_UPDATE_NOTE = 'PC 앱을 업데이트해야 여기서 고른 연결이 적용돼요.';
const LEGACY_NOTE = '서버를 업데이트하면 여기서 MangaDex와 카카오를 연결할 수 있어요.';
const KAKAO_UNAVAILABLE = '서버에 카카오 키가 없어 검색할 수 없어요.';
const PENDING_TEXT = '연결 대기 · PC가 켜지면 적용';
export const KAKAO_GROUPS_HINT = '같은 작품이 권수별로 나뉘어 있으면 여러 개를 함께 고르세요.';

type RowState = {text: string; detail: string; tone: 'ok' | 'idle' | 'pending' | 'failed'; again: boolean};
function rowState(connection: Connection, request: BindRequest | null): RowState {
  if (request?.state === 'pending') return {text: PENDING_TEXT, detail: chosenSummary(request), tone: 'pending', again: true};
  if (request?.state === 'failed') return {text: '연결 실패', detail: request.reason?.message || '이유를 알 수 없어요.', tone: 'failed', again: true};
  if (request?.state === 'applied' && connection !== 'connected') return {text: 'PC에서 적용됨', detail: chosenSummary(request), tone: 'ok', again: true};
  switch (connection) {
    case 'connected': return {text: '연결됨', detail: '', tone: 'ok', again: true};
    case 'aladin': return {text: '알라딘 연결', detail: '카카오로 다시 연결해 주세요.', tone: 'idle', again: true};
    case 'unbound': return {text: '연결 안 됨', detail: '', tone: 'idle', again: false};
    default: return {text: '알 수 없음', detail: '', tone: 'idle', again: false};
  }
}

/** What each provider brings, for the large 작품 연결 panel. */
const PROVIDER_GAINS: Record<BindProvider, string> = {mangadex: '일본판 권 목록 · 표지 · 원제', kakao: '국내 출판 권 목록 · 발매일 · 신간 알림'};
const PANEL_TEXT = '연결하면 권별 표지와 발매일을 가져오고, 새 권이 나오면 신간 알림을 받을 수 있어요. 고르면 PC가 켜질 때 적용됩니다.';
/** Nothing to do for this provider: connected, or a pick is waiting for (or was applied by) the PC. */
const settled = (connection: Connection, request: BindRequest | null) =>
  request?.state === 'failed' ? connection === 'connected' : connection === 'connected' || request?.state === 'pending' || request?.state === 'applied';

/**
 * 연결 for a manga. When both MangaDex and Kakao are settled (connected, or a pick waiting for
 * the PC) it is one small folded row beside the cover, "연결 ✓MangaDex · ✓카카오", which opens
 * to the per-provider rows (다시 연결); a waiting or failed request is spelled out in the folded
 * row. Otherwise it is a prominent 작품 연결 panel under the cover and info (`panelHost`, or in
 * place without one), with Kakao — which brings 신간 알림 — as the primary choice.
 */
export function CollectionBindings({item, active, refreshKey, sheet, onSheet, panelHost}: {item: CollectionDetail; active: boolean; refreshKey: string; sheet: BindProvider | null; onSheet(provider: BindProvider | null): void; /** Where the large panel goes (full width under the intro). */panelHost?: HTMLElement | null}) {
  const [status, setStatus] = useState<BindStatus | null>(null), [legacy, setLegacy] = useState(false);
  const [requests, setRequests] = useState<RequestsReply | null>(null), [loadError, setLoadError] = useState('');
  const [nonce, setNonce] = useState(0), [open, setOpen] = useState(false);
  // A request just filed shows at once, before the list is read again.
  const [filed, setFiled] = useState<Partial<Record<BindProvider, BindRequest>>>({});
  useEffect(() => {
    if (!active || item.type !== 'manga') return;
    const controller = new AbortController();
    void api<BindStatus>(BINDINGS_STATUS_PATH, controller.signal).then(value => { if (!controller.signal.aborted && typeof value?.mangadexSearch === 'boolean') { setStatus(value); setLegacy(false); } },
      reason => { if (!controller.signal.aborted && reason instanceof ApiError && reason.status === 404) setLegacy(true); });
    void api<RequestsReply>(requestsPath(item.id), controller.signal).then(value => { if (!controller.signal.aborted && Array.isArray(value?.items)) { setRequests(value); setLoadError(''); } },
      reason => { if (!controller.signal.aborted && !(reason instanceof ApiError && reason.status === 404)) setLoadError(errorText(reason)); });
    return () => controller.abort();
  }, [active, item.id, item.type, refreshKey, nonce]);
  // The just-filed request stands until a read includes it (or something newer).
  const latest = (provider: BindProvider) => {
    const mine = filed[provider];
    return mine && !requests?.items.some(entry => entry.requestId >= mine.requestId) ? mine : latestRequest(requests, provider);
  };
  const waiting = PROVIDERS.some(provider => latest(provider)?.state === 'pending');
  // A filed request or its result moves `signals.bindingRequests`: read again at once. Without
  // the live status long-poll, look again every minute while a request waits for the PC.
  const signalled = useSyncSignal('bindingRequests', () => setNonce(n => n + 1), active && item.type === 'manga');
  useEffect(() => { if (!active || !waiting) return; return visibleInterval(() => setNonce(n => n + 1), signalled ? SIGNAL_FALLBACK_MS : 60_000); }, [active, waiting, signalled]);
  if (item.type !== 'manga') return null;
  const providers = PROVIDERS.map(provider => {
    const connection = connectionOf(item, provider), request = latest(provider);
    return {provider, name: PROVIDER_NAMES[provider], connection, request, state: rowState(connection, request), settled: settled(connection, request)};
  });
  const notes = <>
    {legacy && <p className="collection-bindings-note">{LEGACY_NOTE}</p>}
    {!legacy && status?.publisherSeenAt === null && <p className="collection-bindings-note">{PUBLISHER_UPDATE_NOTE}</p>}
    {loadError && <div className="collection-bindings-note is-error" role="alert"><span>연결 요청 상태를 불러오지 못했어요.</span><Button size="sm" variant="ghost" onClick={() => setNonce(n => n + 1)}>다시 시도</Button></div>}
  </>;
  const searchSheet = sheet && !legacy && <BindSearchSheet key={sheet} item={item} provider={sheet} status={status} connection={connectionOf(item, sheet)} onClose={() => onSheet(null)}
    onRequested={request => { setFiled(current => ({...current, [request.provider]: request})); onSheet(null); setNonce(n => n + 1); }}/>;

  if (providers.every(entry => entry.settled)) {
    return <section className="collection-bindings is-folded" aria-label="연결">
      <button type="button" className="collection-bindings-fold" aria-expanded={open} onClick={() => setOpen(value => !value)}>
        <LinkIcon aria-hidden="true"/><span className="collection-bindings-fold__label">연결</span>
        {providers.map(({provider, name, state}, index) => <span key={provider} className="collection-bindings-fold__item">
          {index > 0 && <span className="collection-bindings-fold__sep" aria-hidden="true"/>}
          {state.tone === 'pending' ? <span className="collection-bindings-fold__wait"><i aria-hidden="true"/>{name} {state.text}</span>
            : state.tone === 'failed' ? <span className="collection-bindings-fold__failed">{name} {state.text}</span>
            : <span className="collection-bindings-fold__ok"><CheckIcon aria-label="연결됨"/>{name}</span>}
        </span>)}
        <ChevronDownIcon className="collection-bindings-fold__chevron" aria-hidden="true"/>
      </button>
      {open && <div className="collection-bindings-rows">{providers.map(({provider, name, state}) => {
        const verb = `${name} ${state.again ? '다시 연결' : '연결'}`;
        return <div key={provider} className={`collection-binding-row is-${state.tone}`} data-provider={provider}>
          <span className="collection-personal-label">{name}</span>
          <span className="collection-binding-value"><span className="collection-binding-state">{state.text}</span>{state.detail && <small>{state.detail}</small>}</span>
          {!legacy && <Button size="sm" aria-label={verb} onClick={() => onSheet(provider)}>{state.again ? '다시 연결' : '연결'}</Button>}
        </div>;
      })}</div>}
      {notes}
      {searchSheet}
    </section>;
  }

  const panel = <section className="collection-bind-panel" aria-label="연결">
    <h2><LinkIcon aria-hidden="true"/>작품 연결</h2>
    <p>{PANEL_TEXT}</p>
    <div className="collection-bind-choices">{providers.map(({provider, name, connection, state}) => {
      const verb = `${name} ${state.again ? '다시 연결' : '연결'}`;
      const primary = provider === 'kakao';
      // A connected (or waiting) provider stays quiet with a small 다시 연결; the rest are the big buttons.
      if (connection === 'connected' || state.tone === 'pending' || (state.tone === 'ok' && state.again)) {
        return <div key={provider} className={`collection-bind-choice is-done is-${state.tone}`} data-provider={provider}>
          {state.tone === 'pending' ? <i className="collection-bind-choice__wait" aria-hidden="true"/> : <CheckIcon aria-hidden="true"/>}
          <span className="collection-bind-choice__text">{state.tone === 'pending'
            ? <><strong>{name} 연결 대기</strong><small>{['PC가 켜지면 적용', state.detail].filter(Boolean).join(' · ')}</small></>
            : <><strong>{name} {state.text}</strong><small>{state.detail || PROVIDER_GAINS[provider]}</small></>}</span>
          {!legacy && <Button size="sm" variant="ghost" aria-label={verb} onClick={() => onSheet(provider)}>다시 연결</Button>}
        </div>;
      }
      const detail = state.detail ? `${state.text} · ${state.detail}` : PROVIDER_GAINS[provider];
      const body = <><span className="collection-bind-choice__text"><strong>{name} 연결</strong><small>{detail}</small></span><ChevronRightIcon aria-hidden="true"/></>;
      return legacy
        ? <div key={provider} className={`collection-bind-choice is-static is-${state.tone}`} data-provider={provider}>{body}</div>
        : <button key={provider} type="button" className={`collection-bind-choice is-${state.tone}${primary ? ' is-primary' : ''}`} data-provider={provider} aria-label={verb} onClick={() => onSheet(provider)}>{body}</button>;
    })}</div>
    {notes}
    {searchSheet}
  </section>;
  return panelHost ? createPortal(panel, panelHost) : panel;
}

function BindThumb({url, provider}: {url: string | null; provider: BindProvider}) {
  const src = safeImageUrl(url), [broken, setBroken] = useState(false);
  return <span className={`bind-thumb is-${provider}`}>{src && !broken
    ? <img src={src} alt="" loading="lazy" decoding="async" referrerPolicy="no-referrer" onError={() => setBroken(true)}/>
    : <span className="bind-thumb-placeholder"><RectangleStackIcon aria-hidden="true"/></span>}</span>;
}

type Found = {provider: 'mangadex'; query: string; items: MangaDexCandidate[]} | {provider: 'kakao'; query: string; items: KakaoCandidate[]};
type Picked = {
  operationId: string; title: string; subtitle: string; thumbnail: string | null;
  // A Kakao bind of several groups: each group's title and range, and the joined range.
  groups?: {key: string; title: string; range: string}[]; merge?: string;
  build(operationId: string): ReturnType<typeof mangaDexCommand>;
};

/**
 * The search-and-pick sheet for one provider: the server searches (the PC may be off), a tap
 * asks to confirm, and the confirmed pick is filed as a bind request for the PC to apply.
 * Kakao may split one series into groups by volume range, so its results are checked (one or
 * more) and joined into one bind; MangaDex stays a single tap.
 */
export function BindSearchSheet({item, provider, status, connection, onClose, onRequested}: {item: CollectionDetail; provider: BindProvider; status: BindStatus | null; connection: Connection; onClose(): void; onRequested(request: BindRequest): void}) {
  const name = PROVIDER_NAMES[provider];
  const input = useRef<HTMLInputElement>(null), search = useRef<AbortController | null>(null), send = useRef<AbortController | null>(null);
  // MangaDex knows a manga by its original (Japanese) title; Kakao by the Korean edition title.
  const [initialQuery] = useState(() => (provider === 'mangadex' && item.originalTitle?.trim()) || item.name);
  const [query, setQuery] = useState(initialQuery);
  const [busy, setBusy] = useState(false), [found, setFound] = useState<Found | null>(null), [failure, setFailure] = useState<BindFailure | null>(null);
  const [waitUntil, setWaitUntil] = useState(0), [now, setNow] = useState(() => Date.now());
  const [picked, setPicked] = useState<Picked | null>(null), [sending, setSending] = useState(false), [sendFailure, setSendFailure] = useState<BindFailure | null>(null);
  // Checked Kakao groups of the current results, by group fingerprint.
  const [checked, setChecked] = useState<string[]>([]);
  const lastQuery = useRef('');
  const unavailable = provider === 'kakao' && status?.kakaoSearch === false;
  const wait = Math.max(0, Math.ceil((waitUntil - now) / 1000));
  useEffect(() => { if (waitUntil <= Date.now()) return; const timer = window.setInterval(() => { setNow(Date.now()); if (Date.now() >= waitUntil) clearInterval(timer); }, 1000); return () => clearInterval(timer); }, [waitUntil]);
  useEffect(() => () => { search.current?.abort(); send.current?.abort(); }, []);

  const run = (raw: string) => {
    const value = raw.trim();
    if (value.length < 2 || value.length > 100) { setFailure({text: '검색어를 두 글자 이상 100자 이하로 적어 주세요.', retry: false}); return; }
    search.current?.abort();
    const controller = search.current = new AbortController();
    lastQuery.current = value; setBusy(true); setFailure(null);
    void api<SearchReply<MangaDexCandidate | KakaoCandidate>>(searchPath(provider, value), controller.signal).then(reply => {
      if (controller.signal.aborted) return;
      setFound({provider, query: typeof reply.query === 'string' ? reply.query : value, items: Array.isArray(reply.items) ? reply.items : []} as Found);
      setChecked([]); setBusy(false);
    }, reason => {
      if (controller.signal.aborted) return;
      const next = searchFailure(reason, provider);
      // Results of an earlier query would read as answers to this one.
      setFailure(next); setBusy(false); setFound(null); setChecked([]);
      if (next.waitSeconds) { setNow(Date.now()); setWaitUntil(Date.now() + next.waitSeconds * 1000); }
    });
  };
  // The sheet opens already searching for the prefilled title. Focus rests on the sheet,
  // not the field, so the keyboard does not cover the first results.
  useEffect(() => {
    if (!unavailable) run(initialQuery);
    const frame = requestAnimationFrame(() => { if (document.activeElement === input.current) (input.current?.closest('[role=dialog]') as HTMLElement | null)?.focus(); });
    return () => cancelAnimationFrame(frame);
  }, []);
  const submit = (event: FormEvent) => {
    event.preventDefault();
    // Read the field itself: an IME may still be committing the last syllable into state.
    const value = input.current?.value ?? query;
    setQuery(value); input.current?.blur();
    if (!unavailable && !wait) run(value);
  };

  const pickMangaDex = (candidate: MangaDexCandidate) => setPicked({operationId: crypto.randomUUID(), title: candidate.title,
    subtitle: [candidate.author, candidate.year, mangaDexStatus(candidate.status)].filter(Boolean).join(' · '), thumbnail: candidate.coverUrl,
    build: operationId => mangaDexCommand(item.id, operationId, candidate, connection)});
  const toggleKakao = (fingerprint: string) => setChecked(current => current.includes(fingerprint)
    ? current.filter(entry => entry !== fingerprint) : current.length >= MAX_KAKAO_GROUPS ? current : [...current, fingerprint]);
  const kakaoFound = found?.provider === 'kakao' ? found : null;
  const pickKakao = () => {
    if (!kakaoFound) return;
    const chosen = orderGroups(kakaoFound.items.filter(candidate => checked.includes(candidate.groupFingerprint)));
    if (chosen.length === 0) return;
    const lead = chosen[0], queryUsed = kakaoFound.query, several = chosen.length > 1;
    setPicked({operationId: crypto.randomUUID(), title: lead.title,
      subtitle: [lead.author, lead.publisher, several ? '' : kakaoVolumes(lead)].filter(Boolean).join(' · '), thumbnail: lead.thumbnailUrl,
      ...(several ? {groups: chosen.map(candidate => ({key: candidate.groupFingerprint, title: candidate.title, range: kakaoVolumes(candidate) || '권수 모름'})), merge: mergeSummary(chosen)} : {}),
      build: operationId => kakaoCommand(item.id, operationId, queryUsed, chosen, connection)});
  };
  const confirm = () => {
    if (!picked || sending) return;
    const controller = send.current = new AbortController();
    setSending(true); setSendFailure(null);
    // A retry after an unknown outcome reuses the operation id, so the server answers idempotently.
    void fileBindRequest(picked.build(picked.operationId), controller.signal).then(reply => {
      if (controller.signal.aborted) return;
      setSending(false); onRequested(reply.request);
    }, reason => {
      if (controller.signal.aborted) return;
      setSending(false); setSendFailure(requestFailure(reason));
    });
  };

  const searchDisabled = busy || unavailable || wait > 0;
  return <Dialog open title={`${name} 연결`} onClose={onClose}>
    <DialogDescription className="collection-sheet-label">{provider === 'mangadex' ? 'MangaDex에서 작품을 찾아 고르면 PC가 켜질 때 작품 정보와 권별 표지를 가져와요.' : '국내 출판 제목으로 찾으세요. 고르면 PC가 켜질 때 출판사별 권 목록과 발매 정보를 연결해요.'}</DialogDescription>
    <div className="library-sheet bind-sheet">
      <form className="bind-search" role="search" onSubmit={submit}>
        <MagnifyingGlassIcon aria-hidden="true"/>
        <input ref={input} type="search" enterKeyHint="search" aria-label={`${name} 검색어`} value={query} maxLength={100} onChange={event => setQuery(event.target.value)}/>
        <Button type="submit" variant="primary" disabled={searchDisabled}>{busy ? '검색 중…' : '검색'}</Button>
      </form>
      {status?.publisherSeenAt === null && <p className="collection-bindings-note">{PUBLISHER_UPDATE_NOTE}</p>}
      {unavailable && <p className="bind-message is-error" role="alert">{KAKAO_UNAVAILABLE}</p>}
      {failure && <div className="bind-message is-error" role="alert"><span>{failure.text}{failure.waitSeconds ? (wait > 0 ? ` ${wait}초 후에 다시 검색할 수 있어요.` : ' 이제 다시 검색할 수 있어요.') : ''}</span>
        {failure.retry && <Button size="sm" variant="ghost" disabled={searchDisabled} onClick={() => run(lastQuery.current)}>다시 시도</Button>}</div>}
      {busy && <p className="hint" role="status">{name}에서 찾는 중…</p>}
      {found && !busy && found.items.length === 0 && <p className="hint bind-empty">검색 결과가 없어요. 다른 제목으로 찾아 보세요.</p>}
      {found && found.items.length > 0 && <ul className="bind-results" aria-label={`${name} 검색 결과`} aria-busy={busy || undefined}>
        {found.provider === 'mangadex'
          ? found.items.map(candidate => <li key={candidate.mangaId}><button type="button" className="bind-result" onClick={() => pickMangaDex(candidate)}>
              <BindThumb url={candidate.coverUrl} provider="mangadex"/>
              <span className="bind-result-text"><strong>{candidate.title}</strong>
                {candidate.alternateTitles?.length > 0 && <span className="bind-result-alt">{candidate.alternateTitles.slice(0, 3).join(' · ')}</span>}
                <small>{[candidate.author, candidate.year, mangaDexStatus(candidate.status)].filter(Boolean).join(' · ')}</small></span>
            </button></li>)
          : found.items.map(candidate => {
            const on = checked.includes(candidate.groupFingerprint), full = !on && checked.length >= MAX_KAKAO_GROUPS;
            return <li key={candidate.groupFingerprint}><label className={`bind-result is-check${on ? ' is-selected' : ''}${full ? ' is-disabled' : ''}`}>
              <input type="checkbox" checked={on} disabled={full} aria-label={[candidate.title, kakaoVolumes(candidate)].filter(Boolean).join(' ')} onChange={() => toggleKakao(candidate.groupFingerprint)}/>
              <BindThumb url={candidate.thumbnailUrl} provider="kakao"/>
              <span className="bind-result-text"><strong>{candidate.title}</strong>
                <small>{[candidate.author, candidate.publisher].filter(Boolean).join(' · ')}</small>
                {kakaoVolumes(candidate) && <small className="numeric">{kakaoVolumes(candidate)}</small>}</span>
            </label></li>;
          })}
      </ul>}
      {kakaoFound && kakaoFound.items.length > 0 && <p className="hint bind-hint">{KAKAO_GROUPS_HINT}</p>}
      <div className="bind-actions">
        <Button variant="ghost" onClick={onClose}>닫기</Button>
        {provider === 'kakao' && kakaoFound && kakaoFound.items.length > 0 && <Button variant="primary" disabled={checked.length === 0} onClick={pickKakao}>{checked.length}개 묶음 연결</Button>}
      </div>
    </div>
    {picked && <Dialog open title="이 작품으로 연결할까요?" onClose={() => { send.current?.abort(); setSending(false); setPicked(null); setSendFailure(null); }}>
      <DialogDescription className="collection-sheet-label">PC가 켜지면 {name} 정보를 가져와 적용해요. {provider === 'kakao' ? '작품명과 고른 표지는 그대로예요.' : '내가 고친 값은 덮어쓰지 않아요.'}</DialogDescription>
      <div className="library-sheet bind-confirm">
        <div className="bind-result is-static"><BindThumb url={picked.thumbnail} provider={provider}/><span className="bind-result-text"><strong>{picked.title}</strong>{picked.subtitle && <small>{picked.subtitle}</small>}</span></div>
        {picked.groups && <ul className="bind-groups" aria-label="고른 묶음">{picked.groups.map(group => <li key={group.key}><span>{group.title}</span><span className="numeric">{group.range}</span></li>)}</ul>}
        {picked.merge && <p className="bind-merge numeric">{picked.merge}</p>}
        {sendFailure && <p className="bind-message is-error" role="alert">{sendFailure.text}</p>}
        <Button variant="primary" disabled={sending || (!!sendFailure && !sendFailure.retry)} onClick={confirm}>{sending ? '보내는 중…' : sendFailure?.retry ? '다시 보내기' : '연결 요청'}</Button>
        <Button variant="ghost" onClick={() => { send.current?.abort(); setSending(false); setPicked(null); setSendFailure(null); }}>취소</Button>
      </div>
    </Dialog>}
  </Dialog>;
}
