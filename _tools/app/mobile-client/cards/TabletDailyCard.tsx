import {ChevronRightIcon} from '@heroicons/react/24/outline';
import {displayTime} from '../../src/shared/displayDate';
import {useEffect, useRef, useState} from 'react';
import {Button, Dialog, Skeleton} from '../ui';
import {BusyLabel} from '../../src/shared/ui/BusyLabel';
import {HomeSection} from '../../src/home/HomeAttention';
import {BoosterPack} from '../../src/cards/BoosterPack';
import {PackOpening} from '../../src/cards/PackOpening';
import {TradingCard} from '../../src/cards/TradingCard';
import {tierRank, type CardData, type PackCover} from '../../src/cards/types';
import {CardsPrivacy} from './CardsPrivacy';
import {
  displayCards, finishOperation, isUndecided, operationId, readResult, saveResult, tabletCardsApi,
  type OpenResult, type TabletCardsApi,
} from './cardsClient';
import {useAndroidBack} from './useAndroidBack';
import {useTabletCardState} from './useTabletCardState';
import {useCardWarmup} from './warmCards';
import './tabletCards.css';

interface Session { packId: string; cover: PackCover; cards?: CardData[]; undecided?: boolean }
interface DailyCardProps {
  privacy: boolean;
  onOpenAlbum(): void;
  /** The card client; tests supply their own. */
  api?: TabletCardsApi;
  /** Keys this device's retry keys and last result; one value per server connection. */
  root?: string;
  /** False while Home is out of sight: nothing is read or warmed. */
  active?: boolean;
}

/**
 * 오늘의 카드 on the tablet Home (CARD-GACHA-001): the sealed pack, what is still waiting, and the
 * last result. Tapping the pack (or 뜯기) opens the full-screen pack opening built from the same
 * pieces as the PC; the picked cards go to the album with the keep step.
 */
export function TabletDailyCard({privacy, onOpenAlbum, api = tabletCardsApi, root = 'tablet', active = true}: DailyCardProps) {
  return <CardsPrivacy privacy={privacy}><DailyCard api={api} root={root} active={active} onOpenAlbum={onOpenAlbum}/></CardsPrivacy>;
}

function DailyCard({api, root, active, onOpenAlbum}: Required<Omit<DailyCardProps, 'privacy'>>) {
  const {snapshot, error, pending, refresh, retry} = useTabletCardState(api, active);
  useCardWarmup(api, snapshot?.state, active);
  const [session, setSession] = useState<Session | null>(null), [resumeFailed, setResumeFailed] = useState(false);
  const [last, setLast] = useState<{result: OpenResult; cards: CardData[]} | null>(null);
  const mounted = useRef(false);
  useAndroidBack(() => setSession(null), session !== null);
  useEffect(() => {
    mounted.current = true; let live = true;
    const saved = readResult(root);
    if (saved) void displayCards(api, saved.cards, saved.packId).then(cards => { if (live) setLast({result: saved, cards}); });
    return () => { live = false; mounted.current = false; };
  }, [api, root]);
  useEffect(() => {
    const state = snapshot?.state;
    if (!state || state.unopened.length) return;
    let live = true;
    // /state accrues today's daily pack before answering. With no unopened packs, today's granted
    // ids are necessarily closed: POST only retrieves their snapshots.
    const compact = state.day.replace(/-/g, ''), ids = [`d-${compact}`, ...(state.bonusGranted ? [`b-${compact}`] : [])];
    // A result this device already holds for the newest pack needs no request.
    if (readResult(root)?.packId === ids[ids.length - 1]) return;
    void Promise.resolve().then(() => Promise.allSettled(ids.map(id => api.open(id, operationId(root, id))))).then(async replies => {
      const stored = readResult(root);
      const results = replies.flatMap(reply => reply.status === 'fulfilled' ? [reply.value] : []);
      if (stored) results.push(stored);
      const latest = results.sort((a, b) => Date.parse(b.openedAt) - Date.parse(a.openedAt))[0];
      if (!latest || !live) return;
      saveResult(root, latest); replies.forEach((reply, index) => { if (reply.status === 'fulfilled') finishOperation(root, ids[index]); });
      const cards = await displayCards(api, latest.cards, latest.packId);
      if (live) setLast({result: latest, cards});
    }).catch(() => undefined);
    return () => { live = false; };
  }, [api, root, snapshot?.state.revision, snapshot?.state.day, snapshot?.state.unopened.length, snapshot?.state.bonusGranted]);
  const state = snapshot?.state, cover = snapshot?.cover ?? {imageUrls: []};
  const open = async (packId: string) => {
    const result = await api.open(packId, operationId(root, packId));
    saveResult(root, result); finishOperation(root, packId);
    const cards = await displayCards(api, result.cards, result.packId);
    if (mounted.current) { setLast({result, cards}); refresh(); }
    return {cards, alreadyOpened: result.alreadyOpened, undecided: isUndecided(result)};
  };
  /** Puts the chosen slots into the album, then shows the pack as the album now holds it. */
  const keepPack = async (packId: string, slots: number[]) => {
    try {
      const result = await api.keep(packId, operationId(root, packId, 'keep'), slots);
      saveResult(root, result); finishOperation(root, packId, 'keep');
      const cards = await displayCards(api, result.cards, result.packId);
      if (mounted.current) setLast({result, cards});
      refresh();
      return cards;
    } catch (failure) { refresh(); throw failure; }
  };
  const waiting = state?.pendingKeep ?? [];
  /** Reopens an opened pack that was left undecided, here or on another device. */
  const resume = async () => {
    const id = waiting[0]?.packId;
    if (!id) return;
    setResumeFailed(false);
    try {
      const result = await api.pack(id), cards = await displayCards(api, result.cards, result.packId);
      if (mounted.current) setSession({packId: id, cover, cards, undecided: isUndecided(result)});
      if (!isUndecided(result)) refresh();
    } catch { if (mounted.current) setResumeFailed(true); }
  };
  const best = (last?.cards.some(card => card.kept) ? last.cards.filter(card => card.kept) : last?.cards)?.reduce<CardData | null>((current, card) => !current || tierRank(card.tier) > tierRank(current.tier) ? card : current, null);
  const pack = state?.unopened[0];
  const albumLabel = state ? `앨범 ${state.albumSummary.cards}/${state.albumSummary.total}` : '앨범';
  const goAlbum = () => { setSession(null); onOpenAlbum(); };
  const start = () => { if (pack) setSession({packId: pack.id, cover}); };
  // Compact as on the PC (user 2026-10-18): the card alone in a column as wide as it, beside 전송; the album link under it.
  const album = <button type="button" className="home-link tablet-daily-card__album" onClick={goAlbum}>{albumLabel}<ChevronRightIcon aria-hidden="true"/></button>;
  return <HomeSection title="오늘의 카드">
    <div className="tablet-daily-card">
      {!snapshot ? <div className="tablet-daily-card__loading"><BusyLabel busy={pending} delay={400}>{'불러오는 중'}</BusyLabel>{pending && <Skeleton className="tablet-daily-card__skeleton" label="오늘의 카드"/>}{album}</div> : !pack ? <div className="daily-card-result">
        <div className="daily-card-result__art">{best && last && <button type="button" className="daily-card-result__button" aria-label="오늘의 결과 보기" onClick={() => setSession({packId: last.result.packId, cover, cards: last.cards, undecided: waiting.some(item => item.packId === last.result.packId)})}>
          <TradingCard card={best}/>
        </button>}</div>
        <div className="tablet-daily-card__meta"><small>{displayTime(state!.nextResetAt)} 새 팩 증정</small>{album}</div>
      </div> : <>
        <button type="button" className="tablet-daily-card__art tablet-daily-card__pack" aria-label="오늘의 카드 팩 열기" onClick={start}><span aria-hidden="true" inert><BoosterPack cover={cover} disabled/></span></button>
        <div className="tablet-daily-card__copy">
          <Button variant="primary" onClick={start}>뜯기</Button>
          <small>{`남은 팩 ${state!.unopened.length}`}</small>
          {waiting.length > 0 && <Button variant="ghost" onClick={() => { void resume(); }}>{`정리 안 한 팩 ${waiting.length}`}</Button>}
          {state?.bonusGranted && <small>오늘 50장 저장 · 보너스 팩</small>}
          <small>05:00에 새 팩</small>
          {album}
        </div>
      </>}
    </div>
    {resumeFailed && <p role="alert" className="tablet-daily-card__error">정리 안 한 팩을 불러오지 못했습니다. <Button variant="ghost" size="sm" onClick={() => { void resume(); }}>다시 시도</Button></p>}
    {error && <p role="alert" className="tablet-daily-card__error">카드를 불러오지 못했습니다. <Button variant="ghost" size="sm" onClick={retry}>다시 시도</Button></p>}
    <Dialog open={session !== null} title="오늘의 카드" variant="fullscreen" onClose={() => setSession(null)}>
      {session && <div className="tablet-cards"><PackOpening key={session.packId} cover={session.cover} cards={session.cards} initialResults={!!session.cards} undecided={session.undecided}
        loadDraw={session.cards ? undefined : () => open(session.packId)} keep={{onKeep: slots => keepPack(session.packId, slots), onLater: () => setSession(null)}}
        onClose={() => setSession(null)} onAlbum={goAlbum}/></div>}
    </Dialog>
  </HomeSection>;
}
