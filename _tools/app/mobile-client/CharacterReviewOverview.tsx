import {useEffect, useMemo, useRef, useState, type MutableRefObject} from 'react';
import {ArrowLeftIcon, ChevronRightIcon, PhotoIcon} from '@heroicons/react/24/outline';
import {Button, IconButton} from './ui';
import {ApiError, errorText} from './transport';
import {loadThumbnail} from './media';
import {clockLabel} from './homeDashboard';
import type {CharacterIndex} from './characterModel';
import type {ReviewScope} from './CharacterReview';
import {readOverviewSnapshot, readReviewOverview, writeOverviewSnapshot, type ReviewNames, type ReviewOverview} from './useCharacterReview';
import './characterReview.css';

type State =
  | {phase: 'loading'}
  | {phase: 'ready'; value: ReviewOverview; stale: boolean}
  | {phase: 'unready'}
  | {phase: 'error'; message: string; offline: boolean};

/** A character's portrait or a series cover, from the character index's thumbnail Asset. */
function Portrait({id, paused}: {id?: string | null; paused: boolean}) {
  const [loaded, setLoaded] = useState<{id: string; preview?: string}>();
  const preview = loaded && loaded.id === id ? loaded.preview : undefined;
  useEffect(() => {
    if (paused || !id || preview) return;
    const controller = new AbortController();
    void loadThumbnail({id, kind: 'image'}, controller.signal).then(asset => { if (!controller.signal.aborted) setLoaded({id, preview: asset.preview}); }, () => {});
    return () => controller.abort();
  }, [id, paused, preview]);
  return preview ? <img src={preview} alt=""/> : <PhotoIcon aria-hidden="true"/>;
}

/**
 * The character-review overview opened from Home: series sections with their characters and
 * waiting counts, each opening the review scoped to it. Read on open and whenever `refreshKey`
 * changes (a review closed over it); offline it shows the last read with its time.
 */
export function CharacterReviewOverview({libraryId, characters, refreshKey, paused, onOpen, onClose, backRef}: {
  libraryId: string;
  characters?: CharacterIndex | null;
  refreshKey: unknown;
  /** A review is open over it: no thumbnail loads. */
  paused: boolean;
  onOpen(scope: ReviewScope): void;
  onClose(): void;
  backRef: MutableRefObject<(() => boolean) | null>;
}) {
  const [state, setState] = useState<State>({phase: 'loading'});
  const [retry, setRetry] = useState(0);
  const close = useRef(onClose); close.current = onClose;
  useEffect(() => {
    backRef.current = () => { close.current(); return true; };
    return () => { backRef.current = null; };
  }, [backRef]);

  // Names and portraits from the character index (target ids are character source ids).
  const {names, portraits, covers} = useMemo(() => {
    const names: ReviewNames = {characters: {}, series: {}}, portraits: Record<string, string> = {}, covers: Record<string, string> = {};
    for (const node of characters?.nodes ?? []) {
      if (node.kind === 'character') { names.characters[node.sourceId] = node.name; if (node.thumbnailAssetId) portraits[node.sourceId] = node.thumbnailAssetId; }
      if (node.kind === 'series') { names.series[node.sourceId] = node.name; const cover = node.thumbnailAssetId ?? node.heroAssetId; if (cover) covers[node.sourceId] = cover; }
    }
    return {names, portraits, covers};
  }, [characters]);
  const namesRef = useRef(names); namesRef.current = names;

  useEffect(() => {
    const controller = new AbortController();
    void readReviewOverview(controller.signal, namesRef.current).then(value => {
      if (controller.signal.aborted) return;
      if (!value) { setState({phase: 'unready'}); return; }
      writeOverviewSnapshot(libraryId, value);
      setState({phase: 'ready', value, stale: false});
    }, reason => {
      if (controller.signal.aborted) return;
      const offline = reason instanceof ApiError ? reason.status === null : !(reason instanceof DOMException);
      const kept = readOverviewSnapshot(libraryId);
      // Offline (or a failed read): the last overview, marked with when it was read.
      if (kept) setState({phase: 'ready', value: kept, stale: true});
      else setState({phase: 'error', message: errorText(reason), offline});
    });
    return () => controller.abort();
  }, [libraryId, refreshKey, retry]);

  const value = state.phase === 'ready' ? state.value : null;
  const stale = state.phase === 'ready' && state.stale;
  const serverSeries = !!value?.exact;
  return <div className="review-overlay review-overview" role="dialog" aria-modal="true" aria-label="캐릭터 검토">
    <header className="review-bar">
      <IconButton label="홈으로" icon={ArrowLeftIcon} onClick={onClose}/>
      <div className="review-title"><h1>캐릭터 검토</h1>
        {value && <p className="numeric">대기 {value.total}건{value.groups.length > 0 && ` · 시리즈 ${value.groups.length}`}</p>}
      </div>
      {stale && <span className="review-stale numeric">{clockLabel(value!.at)} 기준</span>}
      {value && value.total > 0 && <Button onClick={() => onOpen({target: null})}>전체 검토</Button>}
    </header>
    {state.phase === 'loading' && <div className="loading-line" role="status" aria-label="검토 목록 불러오는 중"/>}
    {state.phase === 'unready' && <div className="empty-state review-empty">
      <h2>PC 업데이트가 필요합니다</h2>
      <p>PC 앱이 아직 캐릭터 검토 목록을 보내지 않았습니다.</p>
    </div>}
    {state.phase === 'error' && <div className="empty-state review-empty">
      <h2>{state.offline ? '오프라인입니다' : '검토 목록을 불러오지 못했습니다'}</h2>
      <p>{state.offline ? '연결되면 검토할 캐릭터를 보여 드립니다.' : state.message}</p>
      <Button onClick={() => { setState({phase: 'loading'}); setRetry(n => n + 1); }}>다시 시도</Button>
    </div>}
    {value && value.total === 0 && <div className="empty-state review-empty">
      <h2>모두 검토했습니다</h2>
      <p>PC가 새 후보를 보내면 여기에 나타납니다.</p>
    </div>}
    {value && value.total > 0 && <div className="overview-scroll">
      {value.groups.map(group => <section key={group.seriesId} className="overview-series" aria-label={`${group.seriesName} ${group.count}건`}>
        <button className="overview-series-head" onClick={() => onOpen({series: {id: group.seriesId, name: group.seriesName}, serverSeries})} aria-label={`${group.seriesName} 전체 검토 ${group.count}건`}>
          <span className="overview-cover"><Portrait id={covers[group.seriesId]} paused={paused}/></span>
          <strong>{group.seriesName}</strong>
          <span className="overview-count numeric">{group.count}</span>
          <ChevronRightIcon aria-hidden="true"/>
        </button>
        <div className="overview-characters">
          {group.characters.map(entry => <button key={entry.id} className="overview-character" onClick={() => onOpen({target: {id: entry.id, name: entry.name}})} aria-label={`${entry.name} 검토 ${entry.count}건`}>
            <span className="overview-portrait"><Portrait id={portraits[entry.id]} paused={paused}/></span>
            <span className="overview-caption"><strong>{entry.name}</strong><span className="numeric">{entry.count}</span></span>
          </button>)}
        </div>
      </section>)}
      {value.rest > 0 && <p className="overview-rest">외 <span className="numeric">{value.rest}</span>건 · 전체 검토에서 이어서 볼 수 있습니다.</p>}
    </div>}
  </div>;
}
