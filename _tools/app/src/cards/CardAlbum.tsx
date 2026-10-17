import { CardAlbumScope } from "./CardAlbumScope";
import { CardAlbumAction } from "./CardAlbumAction";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Button } from "../shared/ui/Button";
import { BusyLabel } from "../shared/ui/BusyLabel";
import { FilterChip } from "../shared/ui/FilterChip";
import { SectionLabel } from "../shared/ui/SectionLabel";
import { useBackHandler } from "../shared/navigation/BackNavigation";
import { Skeleton } from "../shared/ui/Skeleton";
import { displayDate } from "../shared/displayDate";
import { CardViewer } from "./CardViewer";
import { TradingCard } from "./TradingCard";
import { cardsApi, displayCards, type CardsApi } from "./api";
import { groupAlbum } from "./groupAlbum";
import { cardTiers, tierRank, type CardData, type CardTier } from "./types";
import { isLocalPreview } from "./warmup";
import "./album.css";

interface Snapshot { cards: CardData[]; next: string | null; revision: number; pages: number; trashed: boolean }
export function CardAlbum({ api = cardsApi, onBack, onOpenAsset, onCharacter }: {
  api?: CardsApi; onBack: () => void; onOpenAsset?: (id: string) => void; onCharacter?: (id: string) => void;
}) {
  useBackHandler(onBack, 50);
  const [data, setData] = useState<Snapshot | null>(null), dataRef = useRef<Snapshot | null>(null);
  const [pending, setPending] = useState(false), [error, setError] = useState(false);
  const [tier, setTier] = useState<CardTier | "all">("all"), [series, setSeries] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null), [selectedTier, setSelectedTier] = useState<CardTier | null>(null);
  const [trashed, setTrashed] = useState(false);
  const readRef = useRef<(more?: boolean) => void>(() => undefined);
  useEffect(() => {
    let live = true, running = false, refreshQueued = false, rebasing = false;
    const read = async (more = false) => {
      if (running) { if (!more) refreshQueued = true; return; }
      const old = dataRef.current?.trashed === trashed ? dataRef.current : null;
      if (more && !old?.next) return;
      running = true; setPending(true); setError(false);
      try {
        let next = more ? old!.next : null, revision = more ? old!.revision : -1;
        let cards = more ? [...old!.cards] : [];
        const pages = more ? 1 : old?.pages ?? 1;
        let loaded = 0;
        for (; loaded < pages; loaded++) {
          const page = await api.album(next, trashed);
          if (revision !== -1 && page.revision !== revision) {
            // Never combine pages from different album revisions.
            if (rebasing) { refreshQueued = false; throw new Error("Album changed while paging"); }
            rebasing = true; refreshQueued = true; return;
          }
          revision = page.revision;
          cards.push(...await displayCards(api, page.cards)); next = page.nextCursor;
          if (!next) { loaded++; break; }
        }
        if (live) {
          const snapshot = { cards: [...new Map(cards.map(card => [card.id, card])).values()], next, revision, trashed, pages: (more ? old!.pages : 0) + loaded };
          dataRef.current = snapshot; setData(snapshot);
          rebasing = false;
        }
      } catch { if (live) setError(true); }
      finally {
        running = false;
        if (live) {
          setPending(false);
          if (refreshQueued) { refreshQueued = false; void read(); }
        }
      }
    };
    readRef.current = more => { void read(more); };
    const stop = api.subscribe(() => readRef.current()); void read();
    return () => { live = false; stop(); readRef.current = () => undefined; };
  }, [api, trashed]);
  const groups = useMemo(() => groupAlbum(data?.cards ?? [], tier), [data, tier]);
  const visibleGroups = useMemo(() => series ? groups.filter(([name]) => name === series) : groups, [groups, series]);
  const characterCards = data?.cards.filter(card => card.characterId === selected).sort((a, b) => tierRank(b.tier) - tierRank(a.tier)) ?? [];
  const detail = characterCards.find(card => card.tier === selectedTier) ?? characterCards[0];
  const choose = useCallback((card: CardData) => { setSelected(card.characterId ?? null); setSelectedTier(card.tier); }, []);
  // The viewer walks through the cards the album currently lists (tier and series filters applied).
  const viewerCards = useMemo(() => visibleGroups.flatMap(([, characters]) => [...characters.values()].flat()), [visibleGroups]);
  const [viewerId, setViewerId] = useState<string | null>(null);
  const viewerIndex = viewerId ? viewerCards.findIndex(card => card.id === viewerId) : -1;
  const openViewer = useCallback((card: CardData) => { choose(card); setViewerId(card.id); }, [choose]);
  const closeViewer = useCallback(() => setViewerId(null), []);
  // The album's 1280 px preview is enlarged on a tall high-DPI viewer card; the viewer asks the library for a bigger one.
  const sharpArt = useCallback((card: CardData) => Promise.resolve(isLocalPreview(card.artUrl) ? card.artUrl.replace(/\/\d{3,4}$/, "/2560") : ""), []);
  useBackHandler(closeViewer, 60, viewerIndex >= 0);
  const stale = !!data && data.trashed !== trashed;
  const changed = (id: string) => {
    closeViewer();
    const old = dataRef.current;
    if (old) { const next = { ...old, cards: old.cards.filter(card => card.id !== id) }; dataRef.current = next; setData(next); }
    readRef.current();
  };
  const albumAction = (card: CardData) => <CardAlbumAction key={card.id} card={card} trashed={trashed} setTrashed={api.setTrashed} onChanged={changed} />;
  const changeScope = (value: boolean) => { closeViewer(); setSeries(null); setTrashed(value); };
  return <div className="card-album">
    <header className="card-album__header"><Button variant="quiet" onClick={onBack}>홈으로</Button><h1>카드 앨범</h1><span role="status"><BusyLabel busy={pending} delay={400}>불러오는 중</BusyLabel></span></header>
    <CardAlbumScope className="card-album__filters" trashed={trashed} onChange={changeScope}/>
    <div className="card-album__filters" aria-label="카드 등급"><FilterChip aria-pressed={tier === "all"} onClick={() => setTier("all")}>전체</FilterChip>{cardTiers.map(value => <FilterChip key={value} aria-pressed={tier === value} onClick={() => setTier(value)}>{value.toUpperCase()}</FilterChip>)}</div>
    {error && <p role="alert">카드 앨범을 불러오지 못했습니다. <Button variant="quiet" onClick={() => readRef.current()}>다시 시도</Button></p>}
    <div className="card-album__body" inert={stale}>
      <nav className="card-album__index" aria-label="시리즈"><Button variant="quiet" aria-pressed={!series} onClick={() => setSeries(null)}>모든 시리즈</Button>{groups.map(([name, characters]) => <Button key={name} variant="quiet" aria-pressed={series === name} onClick={() => setSeries(name)}>{name} · {characters.size}명</Button>)}</nav>
      <main className="card-album__list">
        {!data && pending && <Skeleton className="card-album__skeleton" label="카드 앨범" />}
        {visibleGroups.map(([name, characters]) => <section key={name}><SectionLabel title={name} count={characters.size} unit="명" /><div className="card-album__grid">{[...characters].map(([id, owned]) => {
          const best = owned[0];
          return <button type="button" className="card-album__tile" key={id} aria-pressed={selected === id} onClick={() => openViewer(best)} aria-label={`${best.characterName} · ${best.tier.toUpperCase()}`}>
            <span className="card-album__card"><TradingCard card={best} /></span><b>{best.characterName}</b><small>{best.tier.toUpperCase()} · ×{best.count} · Lv.{best.level}</small>
            <span className="card-album__tiers" aria-label="보유 등급">{cardTiers.map(value => <i key={value} data-owned={owned.some(card => card.tier === value)}>{value.toUpperCase()}</i>)}</span>
          </button>;
        })}</div></section>)}
        {data && !visibleGroups.length && <p className="card-album__empty">{data.cards.length ? "이 등급의 카드가 없습니다" : data.trashed ? "카드 휴지통이 비어 있습니다" : "아직 모은 카드가 없습니다"}</p>}
        {data?.next && <Button disabled={pending} onClick={() => readRef.current(true)}>더 보기</Button>}
      </main>
      <aside className="card-album__detail" aria-label="카드 상세">{detail ? <div key={detail.id} className="card-album__detail-content">
        <TradingCard card={detail} /><h2>{detail.characterName}</h2><p>{detail.seriesName}</p>
        <div className="card-album__ladder">{characterCards.map(card => <FilterChip key={card.id} aria-pressed={card.id === detail.id} onClick={() => setSelectedTier(card.tier)}>{card.tier.toUpperCase()} ×{card.count}</FilterChip>)}</div>
        <dl><dt>등급</dt><dd>{detail.tier.toUpperCase()}</dd><dt>보유</dt><dd>{detail.count}장</dd><dt>레벨</dt><dd>Lv.{detail.level}</dd><dt>처음 뽑음</dt><dd>{displayDate(detail.firstDrawnAt) || "—"}</dd></dl>
        {albumAction(detail)}
        <Button onClick={() => openViewer(detail)}>크게 보기</Button>
        <Button disabled={!onOpenAsset || !detail.artAssetId} onClick={() => onOpenAsset?.(detail.artAssetId!)}>원본 열기</Button>
        <Button variant="quiet" disabled={!onCharacter || !detail.characterId} onClick={() => onCharacter?.(detail.characterId!)}>캐릭터 폴더</Button>
      </div> : <p>카드를 선택해 주세요</p>}</aside>
    </div>
    {viewerIndex >= 0 && <CardViewer cards={viewerCards} index={viewerIndex} onClose={closeViewer} albumAction={albumAction} onOpenAsset={onOpenAsset} onCharacter={onCharacter} sharpArt={sharpArt}
      onIndexChange={next => { const card = viewerCards[next]; if (card) { choose(card); setViewerId(card.id); } }} />}
  </div>;
}
