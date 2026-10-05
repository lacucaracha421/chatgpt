import { thumbnailUrl } from "../assets/mediaUrl";
import type { CharacterTarget } from "./api";
import { activeCharacterReferences } from "./CharacterRegistry";
import type { CharacterGroup, SeriesFolder } from "./hubApi";
import type { Suggestion } from "./suggestions/client";

/**
 * Thumbnail URLs of the series shelf (strip) cards. The cards and the folder-switch preload both
 * use these, so a preloaded image is the one a card shows. Payload revisions make them cacheable
 * (immutable), so a returning shelf is served from the WebView cache instead of the media protocol.
 */
const shelfThumbnail = (assetId: string, revisions?: Readonly<Record<string, string>>) => thumbnailUrl(assetId, revisions?.[assetId]);

/** A character card: its chosen thumbnail, else its first usable reference. */
export function characterCardImage(target: CharacterTarget): string | null {
  const id = target.thumbnailAssetId ?? activeCharacterReferences(target)[0]?.assetId;
  return id ? shelfThumbnail(id, target.thumbnailRevisions) : null;
}

/** A group card's mosaic slot for one member: its thumbnail, else its first ready reference. */
export function groupMemberImage(target: CharacterTarget): string | null {
  const id = target.thumbnailAssetId ?? target.references.find(reference => reference.status === "ready")?.assetId;
  return id ? shelfThumbnail(id, target.thumbnailRevisions) : null;
}

/** Up to four members a group card shows, in the series' folder order when one is set. */
export function groupPreviewMembers(group: Pick<CharacterGroup, "targetIds">, members: CharacterTarget[]) {
  const ordered = members.filter(member => group.targetIds.includes(member.id));
  const groupMembers = ordered.some(member => member.folderOrder != null)
    ? ordered
    : group.targetIds.flatMap(id => ordered.filter(member => member.id === id));
  return { groupMembers, previews: groupMembers.slice(0, 4) };
}

export const suggestionCardImages = (suggestion: Suggestion) =>
  suggestion.sampleAssetIds.map(id => shelfThumbnail(id, suggestion.sampleThumbnailRevisions));

export const folderCardImage = (folder: SeriesFolder) => folder.thumbnailAssetId
  ? thumbnailUrl(folder.thumbnailAssetId, folder.thumbnailRevision ?? undefined) : null;

/** Each strip card's image URLs in display order: groups, characters, suggestions, then folders (as CharacterGroups lays them out). */
export function seriesShelfCardImages({ members, groups, activeGroupId, suggestions, folders }: {
  members: CharacterTarget[]; groups: Pick<CharacterGroup, "id" | "targetIds">[]; activeGroupId?: string;
  suggestions: Suggestion[]; folders: SeriesFolder[];
}): string[][] {
  const present = <T,>(values: (T | null)[]) => values.filter((value): value is T => value !== null);
  const current = groups.find(group => group.id === activeGroupId);
  const grouped = new Set(groups.flatMap(group => group.targetIds));
  const visibleMembers = current ? members.filter(target => current.targetIds.includes(target.id)) : members.filter(target => !grouped.has(target.id));
  return [
    ...(current ? [] : groups).map(group => present(groupPreviewMembers(group, members).previews.map(groupMemberImage))),
    ...visibleMembers.map(target => present([characterCardImage(target)])),
    ...(current ? [] : suggestions).map(suggestionCardImages),
    ...(current ? [] : folders).map(folder => present([folderCardImage(folder)])),
  ];
}

const SHELF_CARD_WIDTH = 132, SHELF_CARD_GAP = 12, SHELF_FALLBACK_CARDS = 10;

/**
 * How many strip cards a shelf's first screen shows (a partly visible card counts), measured on
 * the mounted shelf or, without one, the gallery that will hold it. Siblings share the width.
 */
export function shelfCardsInView(host: HTMLElement | null): number {
  const track = host?.querySelector<HTMLElement>(".folder-shelf .home-shelf__track");
  const width = track?.clientWidth || host?.querySelector<HTMLElement>(".asset-gallery__scroll")?.clientWidth || 0;
  if (!width) return SHELF_FALLBACK_CARDS;
  const card = track?.firstElementChild?.getBoundingClientRect().width || SHELF_CARD_WIDTH;
  const gap = (track && Number.parseFloat(getComputedStyle(track).columnGap)) || SHELF_CARD_GAP;
  return Math.max(1, Math.ceil((width + gap) / (card + gap)));
}
