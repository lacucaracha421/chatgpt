import type {ReactNode} from 'react';
import {PrivacyProvider} from '../../src/privacy/PrivacyContext';
import {useNsfwFilter} from '../privacyMode';

const noop = () => undefined;
/**
 * Gives the shared card components the tablet's privacy state. Private mode hides every card and
 * pack cover. The NSFW filter has no rating for a card's art here, and an unknown rating never
 * reveals anything, so with the filter on the cards stay hidden as well.
 */
export function CardsPrivacy({privacy, children}: {privacy: boolean; children: ReactNode}) {
  const [nsfwFilter] = useNsfwFilter();
  return <PrivacyProvider privacyMode={privacy} setPrivacyMode={noop} nsfwFilter={nsfwFilter}>{children}</PrivacyProvider>;
}
