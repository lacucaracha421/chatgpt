import {useEffect, useMemo, useRef, useState} from 'react';
import {TradingCard} from '../../src/cards/TradingCard';
import {hasCutoutLayer, type CardData} from '../../src/cards/types';
import {mediumArtUrl, type TabletCardsApi} from './cardsClient';

/** Long edge of the Library thumbnail every card starts with. */
export const THUMBNAIL_EDGE = 360;
/** A thumbnail enlarged by less than this looks the same; keep it instead of loading more bytes. */
const UPSCALE_TOLERANCE = 1.1;

interface Fit { cardWidth: number; cardHeight: number; artWidth: number; artHeight: number; pixelRatio: number }

/**
 * Whether the 360 px thumbnail would be enlarged visibly in a cell. The art covers the card face,
 * so the larger of the two axis scales decides (a wide picture in a portrait card is stretched by
 * its height). An unknown art size is assumed to be a square thumbnail.
 */
export function wantsMedium({cardWidth, cardHeight, artWidth, artHeight, pixelRatio}: Fit): boolean {
  if (!(cardWidth > 0 && cardHeight > 0)) return false;
  const longest = Math.max(artWidth, artHeight);
  // An original no larger than the thumbnail has nothing more to give.
  if (longest > 0 && longest <= THUMBNAIL_EDGE) return false;
  const shrink = longest > 0 ? THUMBNAIL_EDGE / longest : 1;
  const thumbWidth = artWidth > 0 ? artWidth * shrink : THUMBNAIL_EDGE, thumbHeight = artHeight > 0 ? artHeight * shrink : THUMBNAIL_EDGE;
  return Math.max(cardWidth * pixelRatio / thumbWidth, cardHeight * pixelRatio / thumbHeight) > UPSCALE_TOLERANCE;
}

/**
 * A card in an album cell. It shows the thumbnail at once; when the cell is near the screen and the
 * thumbnail would be enlarged, it asks for the server's medium copy and swaps it in once it has
 * decoded (the card's image keeps the thumbnail on screen until then, so nothing blinks).
 */
export function AlbumTileCard({card, api}: {card: CardData; api: TabletCardsApi}) {
  const host = useRef<HTMLSpanElement>(null);
  const [box, setBox] = useState<{width: number; height: number} | null>(null);
  const [near, setNear] = useState(false);
  const [medium, setMedium] = useState<{assetId: string; url: string} | null>(null);
  const assetId = card.artAssetId;
  // A card with a cutout shows generated artwork behind it, not the picture.
  const eligible = !!assetId && card.artMedium === true && !(hasCutoutLayer(card.tier) && card.cutoutUrl);
  useEffect(() => {
    const node = host.current;
    if (!node || !eligible) return;
    const read = () => {
      const rect = node.getBoundingClientRect();
      setBox(old => old && Math.abs(old.width - rect.width) < 1 && Math.abs(old.height - rect.height) < 1 ? old : {width: rect.width, height: rect.height});
    };
    read();
    if (typeof ResizeObserver !== 'function') return;
    const observer = new ResizeObserver(read);
    observer.observe(node);
    return () => observer.disconnect();
  }, [eligible]);
  useEffect(() => {
    const node = host.current;
    if (!node || !eligible || near) return;
    if (typeof IntersectionObserver !== 'function') { setNear(true); return; }
    const observer = new IntersectionObserver(entries => { if (entries.some(entry => entry.isIntersecting)) setNear(true); }, {rootMargin: '400px 0px'});
    observer.observe(node);
    return () => observer.disconnect();
  }, [eligible, near]);
  const wanted = eligible && near && !!box && wantsMedium({
    cardWidth: box.width, cardHeight: box.height, artWidth: card.artWidth, artHeight: card.artHeight, pixelRatio: window.devicePixelRatio || 1,
  });
  const loaded = medium?.assetId === assetId;
  useEffect(() => {
    if (!wanted || !assetId || loaded) return;
    let live = true;
    void mediumArtUrl(api, assetId).then(url => { if (live && url) setMedium({assetId, url}); });
    return () => { live = false; };
  }, [wanted, assetId, loaded, api]);
  const shown = useMemo(() => loaded && medium ? {...card, artUrl: medium.url} : card, [card, loaded, medium]);
  return <span ref={host} className="tablet-card-album__card"><TradingCard card={shown}/></span>;
}
