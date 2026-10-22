import {useMemo} from 'react';
import {DailyCard} from '../../src/cards/DailyCard';
import {CardsPrivacy} from './CardsPrivacy';
import {displayCards, tabletCardsApi, type ServerCard, type TabletCardsApi} from './cardsClient';
import {useAndroidBack} from './useAndroidBack';
import {useTabletCardState} from './useTabletCardState';
import {useCardWarmup} from './warmCards';
import './tabletCards.css';

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
 * 오늘의 카드 on the tablet Home (CARD-GACHA-001): the PC's card section over the tablet's server calls,
 * with touch-size buttons and Android Back closing the pack opening.
 */
export function TabletDailyCard({privacy, onOpenAlbum, api = tabletCardsApi, root = 'tablet', active = true}: DailyCardProps) {
  const cards = useTabletCardState(api, active);
  useCardWarmup(api, cards.snapshot?.state, active);
  const client = useMemo(() => ({open: api.open, keep: api.keep, pack: api.pack, display: (list: readonly ServerCard[], packId?: string) => displayCards(api, list, packId)}), [api]);
  return <CardsPrivacy privacy={privacy}><DailyCard client={client} cards={cards} root={root} onAlbum={onOpenAlbum} touch useBack={useAndroidBack} openingClassName="tablet-cards"/></CardsPrivacy>;
}
