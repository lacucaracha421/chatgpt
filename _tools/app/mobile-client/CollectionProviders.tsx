import {useEffect, useRef, useState} from 'react';
import {BusyLabel} from '../src/shared/ui/BusyLabel';
import {Badge, Button, Dialog, DialogDescription, Field, SegmentedControl, TextInput} from './ui';
import {Fold} from './Fold';
import {api, errorText} from './transport';
import {outboxConnection} from './outboxConnection';
import {replaceCommand, sameAuthority, type Provider} from './collectionCommandOutbox';
import type {useCollectionAuthority} from './useCollectionAuthority';
import type {CollectionDetail} from './collectionModel';
import {artworkCommands, artworkLabel, providerDetailPath, providerFor, providerName, providerPreview,
  providerSearchPath, readProviderBinding, type ArtworkChoice, type ProviderCandidate, type ProviderDetail, type ProviderStatus} from './collectionProviderModel';
import {usePrivacyMode} from './privacyMode';
import './collectionBindings.css';
import './collectionAuthority.css';
import './collectionProviders.css';
import {RectangleStackIcon} from '@heroicons/react/24/outline';

type Authority = ReturnType<typeof useCollectionAuthority>;
export function useProviderStatus(active: boolean, refreshKey?: unknown) {
  const connection = outboxConnection();
  const [reply, setReply] = useState<{connection: string; value: ProviderStatus} | null>(null);
  const [failure, setFailure] = useState('');
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    if (!active || !connection) return;
    const controller = new AbortController();
    void api<ProviderStatus>('/v1/providers/status', controller.signal, undefined, 'GET', false, connection).then(value => {
      if (!controller.signal.aborted && typeof value.tmdb === 'boolean' && typeof value.igdb === 'boolean') {
        setReply({connection, value}); setFailure('');
      }
    }, reason => { if (!controller.signal.aborted) setFailure(errorText(reason)); });
    return () => controller.abort();
  }, [active, connection, retry, refreshKey]);
  return {status: reply?.connection === connection ? reply.value : null, failure, retry: () => setRetry(value => value + 1)};
}
type Status = ReturnType<typeof useProviderStatus>;
function ProviderUnavailable({provider, status}: {provider: Provider; status: Status}) {
  return <p className="collection-bindings-note">{status.status?.[provider] === false ? `서버에 ${providerName(provider)} 키가 설정되지 않았습니다`
    : status.failure ? <>{status.failure}<Button variant="ghost" onClick={status.retry}>다시 시도</Button></> : '서버 연결을 확인해 주세요.'}</p>;
}

export function CollectionProviderActions({item, authority, status, active}: {item: CollectionDetail; authority: Authority; status: Status; active: boolean}) {
  const provider = providerFor(item.type), identity = authority.identity;
  const [open, setOpen] = useState(false), [sheet, setSheet] = useState<'search' | 'artwork' | null>(null);
  const [binding, setBinding] = useState<{workId: string; provider: Provider; externalId: string | null} | null>(null);
  const [busy, setBusy] = useState(false), [failure, setFailure] = useState(''), [retry, setRetry] = useState(0);
  const accepted = authority.acknowledgements.filter(row => row.command.workId === item.id && row.command.commandType === 'providerApply').map(row => row.command.operationId).join(':');
  useEffect(() => {
    if (!active || !provider || !identity || !status.status?.[provider]) return;
    const controller = new AbortController(); setBusy(true);
    void readProviderBinding(identity, item.id, provider, controller.signal).then(externalId => {
      if (!controller.signal.aborted) { setBinding({workId: item.id, provider, externalId}); setBusy(false); setFailure(''); }
    }, reason => { if (!controller.signal.aborted) { setBusy(false); setFailure(errorText(reason)); } });
    return () => controller.abort();
  }, [active, item.id, provider, identity?.libraryId, identity?.epoch, status.status?.[provider!], accepted, retry]);
  if (!provider) return null;
  const name = providerName(provider), available = status.status?.[provider] === true;
  const externalId = binding?.workId === item.id && binding.provider === provider ? binding.externalId : null;
  const waiting = authority.rows.some(row => row.command.workId === item.id && row.state === 'pending');
  return <section className="collection-bindings collection-provider-actions" aria-label={`${name} 연결`}>
    <Button variant="ghost" aria-expanded={open} onClick={() => setOpen(value => !value)}>연결 · {name}{waiting && <Badge>대기</Badge>}</Button>
    <Fold open={open}><div className="collection-bindings-rows">
      <div className="collection-binding-row"><Button disabled={!available || !identity || waiting} onClick={() => setSheet('search')}>{name}에 연결</Button>
        <Button disabled={!available || !identity || !externalId || busy || waiting} onClick={() => {
          try { authority.enqueue({commandType: 'providerApply', workId: item.id, operation: 'refresh', provider, externalId: externalId!}); setFailure(''); }
          catch (reason) { setFailure(errorText(reason)); }
        }}>{name} 새로고침</Button></div>
      <div className="collection-binding-row"><Button disabled={!available || !identity || !externalId || busy || waiting} onClick={() => setSheet('artwork')}>{artworkLabel(provider)}</Button></div>
      {!available && <ProviderUnavailable provider={provider} status={status}/>}
      {available && !externalId && !busy && !failure && <p className="collection-bindings-note">{name}에 연결하면 이미지를 고를 수 있습니다.</p>}
      <BusyLabel busy={busy} idle="">연결 확인 중…</BusyLabel>
      {failure && <p role="alert" className="bind-message is-error">{failure}<Button variant="ghost" onClick={() => setRetry(value => value + 1)}>다시 시도</Button></p>}
    </div></Fold>
    {sheet === 'search' && <ProviderSearchSheet key={item.id} item={item} provider={provider} authority={authority} onClose={() => setSheet(null)}/>}
    {sheet === 'artwork' && externalId && <ProviderArtworkSheet key={item.id} item={item} provider={provider} externalId={externalId} authority={authority} onClose={() => setSheet(null)}/>}
  </section>;
}

export function ProviderThumb({url}: {url: string | null}) {
  const [privacy] = usePrivacyMode(), connection = outboxConnection();
  const source = `${connection}:${url}`;
  const [image, setImage] = useState<{source: string; url: string} | null>(null);
  const [loaded, setLoaded] = useState<string | null>(null), [failed, setFailed] = useState<string | null>(null);
  useEffect(() => {
    if (!url || privacy) return;
    const controller = new AbortController();
    setImage(null); setLoaded(null); setFailed(null);
    void providerPreview(url, controller.signal).then(reply => {
      if (controller.signal.aborted) return;
      if (reply && /^data:image\/(jpeg|png|webp);base64,/.test(reply.url)) setImage({source, url: reply.url});
      else setFailed(source);
    }, () => { if (!controller.signal.aborted) setFailed(source); });
    return () => controller.abort();
  }, [url, privacy, source]);
  const shown = image?.source === source && failed !== source ? image.url : null;
  return <span className="bind-thumb collection-provider-thumb">{privacy ? <span className="privacy-mask" aria-label="비공개 모드"/>
    : <><span className="bind-thumb-placeholder"><RectangleStackIcon aria-hidden="true"/></span>
      {shown && <img key={source} src={shown} alt="" decoding="async" className={loaded === source ? 'is-loaded' : ''}
        onLoad={() => setLoaded(source)} onError={() => setFailed(source)}/>}</>}</span>;
}

export function ProviderSearchSheet({provider, item, authority, onClose}: {provider: Provider; item: CollectionDetail; authority: Authority; onClose(): void}) {
  const [scope] = useState(() => ({connection: outboxConnection(), identity: authority.identity}));
  const [query, setQuery] = useState(item.name), [kind, setKind] = useState<'movie' | 'tv'>('movie');
  const [results, setResults] = useState<ProviderCandidate[] | null>(null), [picked, setPicked] = useState<ProviderDetail | null>(null);
  const [busy, setBusy] = useState(false), [failure, setFailure] = useState(''), [operation, setOperation] = useState<string | null>(null);
  const controller = useRef<AbortController | null>(null);
  const intent = [...authority.rows, ...authority.acknowledgements].find(row => row.command.operationId === operation), pending = intent?.state === 'pending';
  useEffect(() => () => controller.current?.abort(), []);
  useEffect(() => { if (intent?.state === 'accepted') onClose(); }, [intent?.state, onClose]);
  const search = (value: string, searchKind = kind) => {
    value = value.trim(); if (!value) { setFailure('검색어를 입력해 주세요.'); return; }
    controller.current?.abort(); const request = controller.current = new AbortController(); setBusy(true); setFailure('');
    void api<{items: ProviderCandidate[]}>(providerSearchPath(provider, value, searchKind), request.signal).then(reply => {
      if (!request.signal.aborted) { setResults(reply.items); setPicked(null); setBusy(false); }
    }, reason => { if (!request.signal.aborted) { setFailure(errorText(reason)); setBusy(false); } });
  };
  useEffect(() => { if (item.name) search(item.name); }, []);
  const pick = (candidate: ProviderCandidate) => {
    controller.current?.abort(); const request = controller.current = new AbortController(); setBusy(true); setFailure('');
    void api<ProviderDetail>(providerDetailPath(provider, candidate.externalId), request.signal).then(reply => {
      if (!request.signal.aborted) { setPicked(reply); setBusy(false); }
    }, reason => { if (!request.signal.aborted) { setFailure(errorText(reason)); setBusy(false); } });
  };
  const confirm = () => {
    if (!picked || pending || operation) return;
    try {
      if (!scope.identity || !authority.identity || !sameAuthority(scope.identity, authority.identity) || scope.connection !== outboxConnection()) throw new Error('라이브러리가 변경되었습니다. 다시 열어 주세요.');
      const command = {commandType: 'providerApply' as const, provider, externalId: picked.binding.externalId,
        workId: item.id, operation: 'connect' as const};
      setOperation(authority.enqueue(command).command.operationId);
    } catch (reason) { setFailure(errorText(reason)); }
  };
  return <Dialog open title={`${providerName(provider)}에 연결`} onClose={onClose}>
    <DialogDescription className="sr-only">검색 결과를 고른 뒤 작품 정보를 확인해 주세요.</DialogDescription>
    <div className="library-sheet bind-sheet">
      {!operation && <>
        {provider === 'tmdb' && <SegmentedControl label="TMDB 유형" options={[{value: 'movie', label: '영화'}, {value: 'tv', label: 'TV 시리즈'}]} value={kind} onChange={value => {
          setKind(value); if (query.trim()) search(query, value);
        }}/>}
        <form className="collection-provider-search" onSubmit={event => { event.preventDefault(); const input = event.currentTarget.elements.namedItem('query') as HTMLInputElement; search(input.value); input.blur(); }}>
          <Field label="검색어"><TextInput name="query" value={query} maxLength={200} onChange={event => setQuery(event.target.value)}/></Field>
          <Button type="submit" disabled={busy}>검색</Button>
        </form>
      </>}
      <BusyLabel busy={busy} idle="">불러오는 중…</BusyLabel>
      {failure && <p className="bind-message is-error" role="alert">{failure}</p>}
      {picked ? <div className="bind-confirm"><div className="bind-result is-static"><ProviderThumb url={picked.artwork.find(art => ['poster', 'cover'].includes(art.kind))?.previewUrl ?? null}/>
        <span className="bind-result-text"><strong>{picked.metadata.name}</strong><small>{[picked.metadata.originalTitle, picked.metadata.year, picked.metadata.genres, picked.metadata.developer, picked.metadata.director].filter(Boolean).join(' · ')}</small></span></div>
        {picked.metadata.overview && <p>{picked.metadata.overview}</p>}
        {pending && <Badge>대기</Badge>}
        {intent?.state === 'conflict' && <p role="alert">변경을 받지 못했습니다. 연결과 작품 정보를 확인한 뒤 다시 시도해 주세요.</p>}
        <div className="bind-actions"><Button disabled={pending || busy} onClick={() => { if (intent?.state === 'conflict') replaceCommand(intent.command.operationId, null); setOperation(null); setPicked(null); }}>다시 선택</Button>
          <Button variant="primary" disabled={pending || busy || !!operation} onClick={confirm}>연결</Button></div>
      </div> : results && <ul className="bind-results">{results.map(candidate => <li key={candidate.externalId}><button className="bind-result" disabled={busy} onClick={() => pick(candidate)}>
        <ProviderThumb url={candidate.previewUrl}/><span className="bind-result-text"><strong>{candidate.name}</strong><small>{candidate.originalTitle}</small><small>{candidate.year}</small></span>
      </button></li>)}{results.length === 0 && <li className="bind-empty">검색 결과가 없습니다.</li>}</ul>}
      <Button onClick={onClose}>닫기</Button>
    </div>
  </Dialog>;
}

export function ProviderArtworkSheet({item, provider, externalId, authority, onClose}: {item: CollectionDetail; provider: Provider; externalId: string; authority: Authority; onClose(): void}) {
  const [scope] = useState(() => ({connection: outboxConnection(), identity: authority.identity}));
  const [detail, setDetail] = useState<ProviderDetail | null>(null), [busy, setBusy] = useState(false), [failure, setFailure] = useState(''), [retry, setRetry] = useState(0);
  const [choices, setChoices] = useState<Record<string, ArtworkChoice>>({work: 'keep', hero: 'keep', backdrop: 'keep'});
  const [operations, setOperations] = useState<string[]>([]);
  const send = useRef<AbortController | null>(null);
  useEffect(() => {
    const controller = new AbortController(); setBusy(true);
    void api<ProviderDetail>(providerDetailPath(provider, externalId), controller.signal).then(reply => {
      if (!controller.signal.aborted) { setDetail(reply); setBusy(false); setFailure(''); }
    }, reason => { if (!controller.signal.aborted) { setFailure(errorText(reason)); setBusy(false); } });
    return () => controller.abort();
  }, [provider, externalId, retry]);
  useEffect(() => () => send.current?.abort(), []);
  const rows = operations.flatMap(id => { const row = [...authority.rows, ...authority.acknowledgements].find(row => row.command.operationId === id); return row ? [row] : []; });
  const pending = rows.some(row => row.state === 'pending'), conflict = rows.some(row => row.state === 'conflict');
  useEffect(() => { if (operations.length && rows.length === operations.length && rows.every(row => row.state === 'accepted')) onClose(); }, [rows, operations, onClose]);
  const save = async () => {
    if (busy || operations.length || !detail) return;
    const controller = send.current = new AbortController(); setBusy(true); setFailure('');
    try {
      const commands = await artworkCommands(item, provider, choices, controller.signal);
      if (controller.signal.aborted) return;
      if (!scope.identity || !authority.identity || !sameAuthority(scope.identity, authority.identity) || scope.connection !== outboxConnection()) throw new Error('라이브러리가 변경되었습니다. 다시 열어 주세요.');
      if (!commands.length) { onClose(); return; }
      setOperations(authority.enqueueBatch(commands).map(row => row.command.operationId));
    } catch (reason) { if (!controller.signal.aborted) setFailure(errorText(reason)); }
    finally { if (!controller.signal.aborted) setBusy(false); }
  };
  const slots = provider === 'tmdb' ? [{slot: 'work', label: '포스터', kinds: ['poster']}, {slot: 'backdrop', label: '배경', kinds: ['backdrop']}]
    : [{slot: 'work', label: '표지', kinds: ['cover']}, {slot: 'hero', label: 'hero', kinds: ['artwork', 'screenshot']}];
  return <Dialog open title={artworkLabel(provider)} onClose={onClose}><DialogDescription className="sr-only">슬롯마다 유지, 비우기 또는 이미지를 선택합니다.</DialogDescription>
    <div className="library-sheet bind-sheet"><BusyLabel busy={busy} idle="">불러오는 중…</BusyLabel>
      {failure && <p role="alert" className="bind-message is-error">{failure}{!detail && <Button onClick={() => setRetry(value => value + 1)}>다시 시도</Button>}</p>}
      {detail && slots.map(({slot, label, kinds}) => <section key={slot} aria-label={label}><h3>{label}</h3>
        <div className="collection-authority-types">{(['keep', 'clear'] as const).map(choice => <Button key={choice} disabled={busy || !!operations.length} aria-pressed={choices[slot] === choice} onClick={() => setChoices(current => ({...current, [slot]: choice}))}>{choice === 'keep' ? '유지' : '비우기'}</Button>)}</div>
        <div className={`collection-provider-grid ${slot === 'work' ? 'is-cover' : ''}`}>{detail.artwork.filter(art => kinds.includes(art.kind)).map((art, index) => <button key={`${art.kind}:${art.path}`} aria-label={`${label} ${index + 1}`} aria-pressed={typeof choices[slot] === 'object' && (choices[slot] as {path: string}).path === art.path}
          disabled={busy || !!operations.length} onClick={() => setChoices(current => ({...current, [slot]: art}))}><ProviderThumb url={art.previewUrl}/></button>)}</div>
      </section>)}
      {provider === 'tmdb' && detail?.artwork.some(art => art.kind === 'season_poster') && <section aria-label="시즌 포스터"><h3>시즌 포스터</h3><div className="collection-provider-grid is-cover">{detail.artwork.filter(art => art.kind === 'season_poster').map(art => <div key={`${art.seasonNumber}:${art.path}`}><ProviderThumb url={art.previewUrl}/><small>시즌 {art.seasonNumber}</small></div>)}</div></section>}
      {pending && <Badge>대기</Badge>}{conflict && <p role="alert">이미지 변경을 받지 못했습니다. 작품의 대기열에서 충돌을 확인해 주세요.</p>}
      <div className="bind-actions"><Button onClick={onClose}>닫기</Button><Button variant="primary" disabled={busy || !detail || !!operations.length} onClick={() => void save()}>저장</Button></div>
    </div>
  </Dialog>;
}
