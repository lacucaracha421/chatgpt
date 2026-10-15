import {useCallback, useEffect, useMemo, useRef, useState, type MutableRefObject} from 'react';
import {FilterChip} from '../../src/shared/ui/FilterChip';
import {TradingCard} from '../../src/cards/TradingCard';
import {cardTiers, tierRank, type CardData, type CardTier} from '../../src/cards/types';
import {BottomSheet} from '../BottomSheet';
import {usePrivacyMode} from '../privacyMode';
import {TopBar} from '../TopBar';
import {useSyncSignal} from '../syncSignals';
import {Button, EmptyState, Skeleton} from '../ui';
import {CardsPrivacy} from './CardsPrivacy';
import {displayCards, tabletCardsApi, type TabletCardsApi} from './cardsClient';
import './tabletCards.css';

/** Series → characters → the cards owned of each, best tier first. */
export function groupAlbum(cards: readonly CardData[], tier: CardTier | 'all' = 'all') {
  const series = new Map<string, Map<string, CardData[]>>();
  for (const card of cards) {
    if (tier !== 'all' && card.tier !== tier) continue;
    const name = card.seriesName || '시리즈 없음', character = card.characterId ?? card.id;
    if (!series.has(name)) series.set(name, new Map());
    const characters = series.get(name)!;
    characters.set(character, [...(characters.get(character) ?? []), card].sort((a, b) => tierRank(b.tier) - tierRank(a.tier)));
  }
  return [...series].sort(([a], [b]) => a.localeCompare(b, 'ko'));
}

interface Snapshot { cards: CardData[]; next: string | null; revision: number; pages: number }
interface AlbumProps {
  /** Android Back: closes the detail sheet first, then the album. */
  backRef?: MutableRefObject<(() => boolean) | null>;
  onClose(): void;
  /** Shown only when the host can open the card's source Asset or the character's folder. */
  onOpenAsset?(assetId: string): void;
  onCharacter?(characterId: string): void;
  api?: TabletCardsApi;
}

/**
 * The shared character album (CARD-GACHA-001), one column of series with the owned characters as
 * tiles; a tap opens the card in a bottom sheet where a finger drag tilts it.
 */
export function TabletCardAlbum({api = tabletCardsApi, ...props}: AlbumProps) {
  const [privacy] = usePrivacyMode();
  return <CardsPrivacy privacy={privacy}><Album api={api} {...props}/></CardsPrivacy>;
}

function Album({api, backRef, onClose, onOpenAsset, onCharacter}: Required<Pick<AlbumProps, 'api'>> & Omit<AlbumProps, 'api'>) {
  const [data, setData] = useState<Snapshot | null>(null), dataRef = useRef<Snapshot | null>(null);
  const [pending, setPending] = useState(false), [error, setError] = useState(false);
  const [tier, setTier] = useState<CardTier | 'all'>('all'), [series, setSeries] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null), [selectedTier, setSelectedTier] = useState<CardTier | null>(null);
  const readRef = useRef<(more?: boolean) => void>(() => undefined);
  const moreRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const controller = new AbortController();
    let live = true, running = false, refreshQueued = false, rebasing = false;
    const read = async (more = false) => {
      if (running) { if (!more) refreshQueued = true; return; }
      const old = dataRef.current;
      if (more && !old?.next) return;
      running = true; setPending(true); setError(false);
      try {
        let next = more ? old!.next : null, revision = more ? old!.revision : -1;
        const cards = more ? [...old!.cards] : [];
        // A refresh re-reads as many pages as are already shown.
        const pages = more ? 1 : old?.pages ?? 1;
        let loaded = 0;
        for (; loaded < pages; loaded++) {
          const page = await api.album(next, controller.signal);
          if (revision !== -1 && page.revision !== revision) {
            // Never combine pages from different album revisions.
            if (rebasing) { refreshQueued = false; throw new Error('Album changed while paging'); }
            rebasing = true; refreshQueued = true; return;
          }
          revision = page.revision;
          cards.push(...await displayCards(api, page.cards)); next = page.nextCursor;
          if (!next) { loaded++; break; }
        }
        if (live) {
          const snapshot = {cards: [...new Map(cards.map(card => [card.id, card])).values()], next, revision, pages: (more ? old!.pages : 0) + loaded};
          dataRef.current = snapshot; setData(snapshot);
          rebasing = false;
        }
      } catch (reason) { if (live && !(reason instanceof DOMException && reason.name === 'AbortError')) setError(true); }
      finally {
        running = false;
        if (live) {
          setPending(false);
          if (refreshQueued) { refreshQueued = false; void read(); }
        }
      }
    };
    readRef.current = more => { void read(more); };
    void read();
    return () => { live = false; controller.abort(); readRef.current = () => undefined; };
  }, [api]);
  useSyncSignal('cards', () => readRef.current());
  // The next page loads when the end of the list scrolls near; the 더 보기 button stays as the fallback.
  const hasNext = !!data?.next;
  useEffect(() => {
    const node = moreRef.current;
    if (!node || !hasNext || typeof IntersectionObserver !== 'function') return;
    const observer = new IntersectionObserver(entries => { if (entries.some(entry => entry.isIntersecting)) readRef.current(true); }, {rootMargin: '600px 0px'});
    observer.observe(node);
    return () => observer.disconnect();
  }, [hasNext, data?.cards.length]);
  const groups = useMemo(() => groupAlbum(data?.cards ?? [], tier), [data, tier]);
  const visibleGroups = series ? groups.filter(([name]) => name === series) : groups;
  const characterCards = useMemo(() => data?.cards.filter(card => card.characterId === selected).sort((a, b) => tierRank(b.tier) - tierRank(a.tier)) ?? [], [data, selected]);
  const detail = characterCards.find(card => card.tier === selectedTier) ?? characterCards[0];
  const choose = useCallback((card: CardData) => { setSelected(card.characterId ?? null); setSelectedTier(card.tier); }, []);
  const closeDetail = useCallback(() => { setSelected(null); setSelectedTier(null); }, []);
  const sheetOpen = !!selected && !!detail;
  useEffect(() => {
    if (!backRef) return;
    backRef.current = () => { if (sheetOpen) closeDetail(); else onClose(); return true; };
    return () => { backRef.current = null; };
  }, [backRef, sheetOpen, closeDetail, onClose]);
  return <div className="tablet-cards tablet-card-album">
    <TopBar title="카드 앨범" back={{label: '홈으로', onClick: onClose}} loading={pending && '카드 앨범 불러오는 중'}/>
    <div className="tablet-card-album__filters" role="group" aria-label="카드 등급">
      <FilterChip aria-pressed={tier === 'all'} onClick={() => setTier('all')}>전체</FilterChip>
      {cardTiers.map(value => <FilterChip key={value} aria-pressed={tier === value} onClick={() => setTier(value)}>{value.toUpperCase()}</FilterChip>)}
    </div>
    {groups.length > 1 && <div className="tablet-card-album__filters tablet-card-album__series" role="group" aria-label="시리즈">
      <FilterChip aria-pressed={!series} onClick={() => setSeries(null)}>모든 시리즈</FilterChip>
      {groups.map(([name, characters]) => <FilterChip key={name} aria-pressed={series === name} onClick={() => setSeries(name)}>{`${name} · ${characters.size}명`}</FilterChip>)}
    </div>}
    {error && <p role="alert" className="tablet-card-album__error">카드 앨범을 불러오지 못했습니다. <Button variant="ghost" size="sm" onClick={() => readRef.current()}>다시 시도</Button></p>}
    <main className="tablet-card-album__list">
      {!data && pending && <Skeleton className="tablet-card-album__skeleton" label="카드 앨범"/>}
      {visibleGroups.map(([name, characters]) => <section key={name} aria-label={name}>
        <h2 className="tablet-card-album__series-title">{name}<small>{`${characters.size}명`}</small></h2>
        <div className="tablet-card-album__grid">{[...characters].map(([id, owned]) => {
          const best = owned[0];
          return <button type="button" className="tablet-card-album__tile" key={id} aria-pressed={selected === id} onClick={() => choose(best)} aria-label={`${best.characterName} · ${best.tier.toUpperCase()}`}>
            <span className="tablet-card-album__card"><TradingCard card={best}/></span>
            <b>{best.characterName}</b>
            <small>{best.tier.toUpperCase()} · ×{best.count} · Lv.{best.level}</small>
            <span className="tablet-card-album__tiers" aria-label="보유 등급">{cardTiers.map(value => <i key={value} data-owned={owned.some(card => card.tier === value)}>{value.toUpperCase()}</i>)}</span>
          </button>;
        })}</div>
      </section>)}
      {data && !visibleGroups.length && <EmptyState inline title={data.cards.length ? '이 등급의 카드가 없습니다' : '아직 모은 카드가 없습니다'}/>}
      {data?.next && <div ref={moreRef} className="tablet-card-album__more"><Button disabled={pending} onClick={() => readRef.current(true)}>더 보기</Button></div>}
    </main>
    {sheetOpen && <BottomSheet tall title={detail.characterName} onClose={closeDetail}>
      <div className="tablet-card-album__detail" key={detail.id}>
        <div className="tablet-card-album__detail-card"><TradingCard card={detail}/></div>
        <p>{detail.seriesName}</p>
        <div className="tablet-card-album__ladder" role="group" aria-label="보유 등급">{characterCards.map(card => <FilterChip key={card.id} aria-pressed={card.id === detail.id} onClick={() => setSelectedTier(card.tier)}>{`${card.tier.toUpperCase()} ×${card.count}`}</FilterChip>)}</div>
        <dl><dt>등급</dt><dd>{detail.tier.toUpperCase()}</dd><dt>보유</dt><dd>{detail.count}장</dd><dt>레벨</dt><dd>Lv.{detail.level}</dd><dt>처음 뽑음</dt><dd>{detail.firstDrawnAt ? new Date(detail.firstDrawnAt).toLocaleDateString('ko-KR') : '—'}</dd></dl>
        {(onOpenAsset && detail.artAssetId || onCharacter && detail.characterId) && <div className="tablet-card-album__actions">
          {onOpenAsset && detail.artAssetId && <Button onClick={() => onOpenAsset(detail.artAssetId!)}>원본 열기</Button>}
          {onCharacter && detail.characterId && <Button variant="ghost" onClick={() => onCharacter(detail.characterId!)}>캐릭터 폴더</Button>}
        </div>}
      </div>
    </BottomSheet>}
  </div>;
}
