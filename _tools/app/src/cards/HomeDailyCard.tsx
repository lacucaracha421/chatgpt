import { useMemo } from "react";
import { cardsApi, displayCards, type CardsApi } from "./api";
import { DailyCard } from "./DailyCard";
import { useCardState } from "./useCardState";
import { useCardWarmup } from "./warmup";

/** 오늘의 카드 on the PC Home: the shared card section over the PC's card bridge. */
export function HomeDailyCard({ api = cardsApi, root = "", active = true, onAlbum }: {
  api?: CardsApi; root?: string; active?: boolean; onAlbum?: () => void;
}) {
  const cards = useCardState(api, active);
  useCardWarmup(api, cards.snapshot?.state, active);
  const client = useMemo(() => ({ open: api.open, keep: api.keep, pack: api.pack, display: (list: Parameters<typeof displayCards>[1], packId?: string) => displayCards(api, list, packId) }), [api]);
  return <DailyCard client={client} cards={cards} root={root} onAlbum={onAlbum} />;
}
