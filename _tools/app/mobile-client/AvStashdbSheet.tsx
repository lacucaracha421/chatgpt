import {useEffect, useRef, useState} from 'react';
import {displayDate} from '../src/shared/displayDate';
import {useDelayedBusy} from '../src/shared/useDelayedBusy';
import {BottomSheet} from './BottomSheet';
import {Button, Dialog, DialogDescription, Field, TextInput} from './ui';
import {outboxConnection} from './outboxConnection';
import {personRevision, readCommands, sameAuthority, validatePortraitManifest, type PersonRevisionCommand, type PortraitManifest} from './collectionCommandOutbox';
import type {CollectionPerson} from './collectionModel';
import type {useCollectionAuthority} from './useCollectionAuthority';
import {stashdbError, stashdbPreview, stashdbRead, STASHDB_NOT_CONFIGURED, STASHDB_OLD_SERVER, type StashdbPerformer} from './stashdbModel';
import './avStashdb.css';

type Authority = ReturnType<typeof useCollectionAuthority>;
export function AvStashdbSheet({mode, person, name, privacy, authority, onClose, onPortrait}: {
  mode: 'profile' | 'portrait'; person: CollectionPerson; name: string; privacy: boolean; authority: Authority;
  onClose(): void; onPortrait(command: PersonRevisionCommand, url: string | null, operationId: string): void;
}) {
  const [scope] = useState(() => ({connection: outboxConnection(), identity: authority.identity}));
  const [query, setQuery] = useState(name), [results, setResults] = useState<StashdbPerformer[] | null>(null);
  const [photos, setPhotos] = useState<StashdbPerformer | null>(null), [urls, setUrls] = useState<Record<string, string>>({});
  const [configured, setConfigured] = useState(false), [busy, setBusy] = useState(true), [failure, setFailure] = useState('');
  const [confirm, setConfirm] = useState<'profile' | 'portrait' | null>(null), [retry, setRetry] = useState(0);
  const work = useRef<AbortController | null>(null), previews = useRef<AbortController | null>(null), lock = useRef(false);
  const showBusy = useDelayedBusy(busy, {delay: 400});
  const revision = personRevision(person.id, person.entityRevision, authority.rows);
  const ready = revision !== null && !!scope.identity && !!authority.identity && sameAuthority(scope.identity, authority.identity) && scope.connection === outboxConnection();
  useEffect(() => () => { work.current?.abort(); previews.current?.abort(); }, []);
  useEffect(() => {
    work.current?.abort();
    const controller = new AbortController(); work.current = controller;
    setBusy(true); setFailure(''); setConfigured(false);
    void stashdbRead<{stashdb?: boolean}>('/v1/providers/status', controller.signal, undefined, scope.connection).then(async status => {
      if (status.stashdb === undefined) throw new Error(STASHDB_OLD_SERVER);
      if (!status.stashdb) throw new Error(STASHDB_NOT_CONFIGURED);
      if (controller.signal.aborted) return;
      setConfigured(true);
      if (mode === 'portrait' && person.stashdbId && !privacy) {
        const detail = await stashdbRead<StashdbPerformer>(`/v1/providers/stashdb/performers/${encodeURIComponent(person.stashdbId)}`, controller.signal, undefined, scope.connection);
        if (!controller.signal.aborted) setPhotos(detail);
      }
    }).catch(error => { if (!controller.signal.aborted) setFailure(stashdbError(error)); }).finally(() => { if (!controller.signal.aborted) setBusy(false); });
    return () => { controller.abort(); previews.current?.abort(); };
  }, [mode, person.stashdbId, privacy, retry, scope]);
  useEffect(() => {
    if (privacy) return;
    const controller = new AbortController(); previews.current = controller;
    const entries = mode === 'profile' ? (results ?? []).map(item => ({id: item.stashdbId, url: item.previewUrl ?? item.imageUrl})) : photos?.images ?? [];
    // All previews start at once; `stashdbPreview` keeps at most three requests in flight.
    for (const entry of entries) {
      if (!entry.url) continue;
      void (async () => {
        try {
          const url = await stashdbPreview(entry.url!, controller.signal, scope.connection);
          // Decode before making the preview selectable or transferring it to the page.
          await new Promise<void>((resolve, reject) => { const image = new Image(); image.onload = () => resolve(); image.onerror = () => reject(new Error('사진을 불러오지 못했습니다.')); image.src = url; });
          if (!controller.signal.aborted) setUrls(current => ({...current, [entry.id]: url}));
        } catch (error) { if (!controller.signal.aborted) setFailure(stashdbError(error)); }
      })();
    }
    return () => controller.abort();
  }, [results, photos, privacy, mode, scope, retry]);
  const enqueue = (wish: {commandType: 'setPersonProfile'; stashdbId: string | null} | {commandType: 'setPersonPortrait'; portrait: ({kind: 'image'} & PortraitManifest) | null}, url: string | null = null) => {
    if (!ready || !scope.identity || scope.connection !== outboxConnection()) throw new Error('앞선 배우 변경을 보낸 뒤 다시 선택해 주세요.');
    const currentRevision = personRevision(person.id, person.entityRevision, readCommands().filter(row => sameAuthority(row.command, scope.identity!)));
    if (currentRevision === null) throw new Error('앞선 배우 변경을 보낸 뒤 다시 선택해 주세요.');
    const command: PersonRevisionCommand = {...wish, personId: person.id, expectedRevision: currentRevision};
    const row = authority.enqueue(command, name);
    if (command.commandType === 'setPersonPortrait') onPortrait(command, url, row.command.operationId);
    onClose();
  };
  const act = (run: () => void) => { try { run(); } catch (error) { setFailure(stashdbError(error)); } };
  const search = async () => {
    if (lock.current || !configured || !query.trim()) return;
    lock.current = true; previews.current?.abort(); setBusy(true); setFailure('');
    const controller = new AbortController(); work.current?.abort(); work.current = controller;
    try {
      const reply = await stashdbRead<{items: StashdbPerformer[]}>(`/v1/providers/stashdb/search?${new URLSearchParams({query: query.trim()})}`, controller.signal, undefined, scope.connection);
      if (!controller.signal.aborted) { setResults(reply.items); }
    } catch (error) { if (!controller.signal.aborted) setFailure(stashdbError(error)); }
    finally { lock.current = false; if (!controller.signal.aborted) setBusy(false); }
  };
  const choosePhoto = async (imageId: string) => {
    const url = urls[imageId];
    if (lock.current || !ready || privacy || !person.stashdbId || !url) return;
    lock.current = true; previews.current?.abort(); setBusy(true); setFailure('');
    const controller = new AbortController(); work.current?.abort(); work.current = controller;
    try {
      const manifest = await stashdbRead<PortraitManifest>('/v1/providers/stashdb/portrait', controller.signal, {stashdbId: person.stashdbId, imageId}, scope.connection);
      validatePortraitManifest(manifest);
      if (!controller.signal.aborted) enqueue({commandType: 'setPersonPortrait', portrait: {kind: 'image', ...manifest}}, url);
    } catch (error) { if (!controller.signal.aborted) setFailure(stashdbError(error)); }
    finally { lock.current = false; if (!controller.signal.aborted) setBusy(false); }
  };
  return <BottomSheet title={mode === 'profile' ? 'StashDB 프로필 선택' : '사진 바꾸기'} onClose={onClose}>
    <div className="tablet-stashdb">
      {mode === 'profile' ? <>
        <form onSubmit={event => { event.preventDefault(); void search(); }}><Field label="배우 이름"><TextInput value={query} maxLength={200} onChange={event => setQuery(event.target.value)}/></Field><Button type="submit" disabled={busy || !configured || !query.trim()}>검색</Button></form>
        {results && <div className="tablet-stashdb__candidates" aria-label="StashDB 검색 결과">{results.map(candidate => <Button key={candidate.stashdbId} variant="ghost" aria-label={`${candidate.name} ${candidate.aliases.join(" · ")} ${displayDate(candidate.birthDate)}`} disabled={!ready || busy || !configured} onClick={() => act(() => enqueue({commandType: 'setPersonProfile', stashdbId: candidate.stashdbId}))}>
          {!privacy && urls[candidate.stashdbId] && <img src={urls[candidate.stashdbId]} alt=""/>}<span><b>{candidate.name}</b><small>{candidate.aliases.join(' · ')}</small><small>{displayDate(candidate.birthDate)}</small></span>
        </Button>)}{results.length === 0 && <p>검색 결과가 없습니다.</p>}</div>}
        {person.stashdbId && <Button disabled={!ready || busy || !configured} onClick={() => act(() => enqueue({commandType: 'setPersonProfile', stashdbId: person.stashdbId!}))}>새로고침</Button>}
        {(person.stashdbId || person.profile) && <Button disabled={!ready || lock.current} onClick={() => setConfirm('profile')}>연결 해제</Button>}
      </> : <>
        {privacy ? <p>프라이버시 모드에서는 사진을 표시하지 않습니다.</p> : !person.stashdbId ? <p>StashDB 프로필을 먼저 선택해 주세요.</p> : <div className="tablet-stashdb__photos" aria-label="StashDB 사진">{photos?.images.map((photo, index) => <Button key={photo.id} variant="ghost" aria-label={`사진 ${index + 1} 선택`} disabled={!ready || busy || !urls[photo.id]} onClick={() => void choosePhoto(photo.id)}>{urls[photo.id] ? <img src={urls[photo.id]} alt=""/> : <span>사진 {index + 1}</span>}</Button>)}{photos && photos.images.length === 0 && <p>StashDB 사진이 없습니다.</p>}</div>}
        <Button disabled={!ready || lock.current} onClick={() => setConfirm('portrait')}>사진 지우기</Button>
      </>}
      {!ready && <p>앞선 배우 변경을 보낸 뒤 다시 선택해 주세요.</p>}
      {showBusy && <p role="status">{mode === 'profile' ? '조회 중' : '사진 준비 중'}</p>}
      {failure && <div role="alert"><p>{failure}</p><Button disabled={busy} onClick={() => setRetry(value => value + 1)}>다시 시도</Button></div>}
    </div>
    {confirm && <Dialog open title={confirm === 'profile' ? 'StashDB 연결을 해제할까요?' : '사진을 지울까요?'} onClose={() => setConfirm(null)}><DialogDescription>다른 기기에도 적용됩니다.</DialogDescription><div className="ui-dialog__actions"><Button onClick={() => setConfirm(null)}>취소</Button><Button variant="primary" disabled={!ready || lock.current} onClick={() => act(() => enqueue(confirm === 'profile' ? {commandType: 'setPersonProfile', stashdbId: null} : {commandType: 'setPersonPortrait', portrait: null}))}>{confirm === 'profile' ? '연결 해제' : '사진 지우기'}</Button></div></Dialog>}
  </BottomSheet>;
}
