import type {Asset} from './types';

export type LibraryArtist = {
  id: string;
  label: string;
  displayName?: string | null;
  sourceName?: string | null;
  keys: string[];
  assetCount: number;
  recentCount: number;
  firstSavedAt?: string | null;
  lastSavedAt?: string | null;
  lastOpenedAt?: string | null;
  pinned: boolean;
  hidden: boolean;
  main: boolean;
  coverAssetIds: string[];
};

export type ArtistSort = 'recent' | 'count' | 'name';

export type ArtistAssignment = {assetId: string; artistId: string; source?: 'manual' | 'source_url'};
export type LibraryArtistsReply = {
  version?: number;
  revision?: number | string;
  publishedAt?: string | null;
  generatedAt?: string | null;
  settings?: {mainMinCount?: number; recentMinCount?: number; recentDays?: number} | null;
  unknown?: {none?: number; source?: number} | null;
  artists?: LibraryArtist[];
  assignments?: ArtistAssignment[];
};
export type ArtistDetailReply = {version?: number; revision?: number | string; artist?: LibraryArtist; assignedAssetCount?: number};

const CHOSEONG = ['ㄱ', 'ㄲ', 'ㄴ', 'ㄷ', 'ㄸ', 'ㄹ', 'ㅁ', 'ㅂ', 'ㅃ', 'ㅅ', 'ㅆ', 'ㅇ', 'ㅈ', 'ㅉ', 'ㅊ', 'ㅋ', 'ㅌ', 'ㅍ', 'ㅎ'];
const CHOSEONG_SET = new Set(CHOSEONG);

export function artistName(artist: LibraryArtist): string {
  return artist.displayName?.trim() || artist.label.trim() || artist.sourceName?.trim() || artist.id;
}

export function artistHandle(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return '';
  const x = trimmed.match(/^https?:\/\/(?:www\.)?(?:x\.com|twitter\.com)\/([^/?#]+)/i);
  if (x) return `@${x[1]}`;
  if (/^https?:\/\//i.test(trimmed)) return trimmed.replace(/^https?:\/\//i, '').replace(/\/$/, '');
  return trimmed.startsWith('@') ? trimmed : `@${trimmed}`;
}

export function artistHandles(artist: LibraryArtist): string[] {
  const values = artist.keys.map(artistHandle).filter(Boolean);
  return [...new Set(values)].slice(0, 3);
}

export function assetFromId(id: string): Asset {
  return {id, kind: 'image', thumbnail_available: true};
}

export function assetsFromIds(ids: string[]): Asset[] {
  return [...new Set(ids.filter(id => typeof id === 'string' && id.length > 0))].map(assetFromId);
}

export function normalizeArtist(value: unknown): LibraryArtist | null {
  if (!value || typeof value !== 'object') return null;
  const row = value as Partial<LibraryArtist>;
  if (typeof row.id !== 'string' || typeof row.label !== 'string') return null;
  return {
    id: row.id,
    label: row.label,
    displayName: typeof row.displayName === 'string' ? row.displayName : null,
    sourceName: typeof row.sourceName === 'string' ? row.sourceName : null,
    keys: Array.isArray(row.keys) ? row.keys.filter((key): key is string => typeof key === 'string') : [],
    assetCount: typeof row.assetCount === 'number' && row.assetCount >= 0 ? row.assetCount : 0,
    recentCount: typeof row.recentCount === 'number' && row.recentCount >= 0 ? row.recentCount : 0,
    firstSavedAt: typeof row.firstSavedAt === 'string' ? row.firstSavedAt : null,
    lastSavedAt: typeof row.lastSavedAt === 'string' ? row.lastSavedAt : null,
    lastOpenedAt: typeof row.lastOpenedAt === 'string' ? row.lastOpenedAt : null,
    pinned: row.pinned === true,
    hidden: row.hidden === true,
    main: row.main === true,
    coverAssetIds: Array.isArray(row.coverAssetIds) ? row.coverAssetIds.filter((id): id is string => typeof id === 'string') : [],
  };
}

export function normalizeArtists(value: unknown): LibraryArtist[] {
  if (!value || typeof value !== 'object') return [];
  const rows = (value as {artists?: unknown}).artists;
  if (!Array.isArray(rows)) return [];
  return rows.map(normalizeArtist).filter((artist): artist is LibraryArtist => !!artist && !artist.hidden);
}

export function normalizeAssignments(value: unknown): ArtistAssignment[] {
  if (!value || typeof value !== 'object') return [];
  const rows = (value as {assignments?: unknown}).assignments;
  if (!Array.isArray(rows)) return [];
  return rows.filter((row): row is ArtistAssignment => {
    if (!row || typeof row !== 'object') return false;
    const value = row as Partial<ArtistAssignment>;
    return typeof value.assetId === 'string' && typeof value.artistId === 'string';
  });
}

export function choseongOf(value: string): string {
  return Array.from(value).map(character => {
    const code = character.charCodeAt(0);
    if (code < 0xac00 || code > 0xd7a3) return character;
    return CHOSEONG[Math.floor((code - 0xac00) / 588)] ?? character;
  }).join('');
}

function queryValue(value: string): string { return value.toLocaleLowerCase('ko-KR').replace(/\s+/g, ''); }

export function searchValues(artist: LibraryArtist): string[] {
  return [artistName(artist), artist.label, artist.displayName ?? '', artist.sourceName ?? '', ...artist.keys];
}

export function matchesArtist(artist: LibraryArtist, query: string): boolean {
  const needle = queryValue(query);
  if (!needle) return true;
  return searchValues(artist).some(value => {
    const text = queryValue(value);
    return text.includes(needle) || (Array.from(needle).every(character => CHOSEONG_SET.has(character)) && choseongOf(value).includes(needle));
  });
}

/** Positions in a label to underline. Choseong queries underline the matching Korean syllables. */
export function matchedPositions(label: string, query: string): Set<number> {
  const needle = queryValue(query);
  const positions = new Set<number>();
  if (!needle) return positions;
  const text = queryValue(label);
  const at = text.indexOf(needle);
  if (at >= 0) {
    Array.from(needle).forEach((_, index) => positions.add(at + index));
    return positions;
  }
  if (!Array.from(needle).every(character => CHOSEONG_SET.has(character))) return positions;
  const initials = choseongOf(label);
  let queryIndex = 0;
  Array.from(initials).forEach((initial, index) => {
    if (initial === Array.from(needle)[queryIndex]) {
      positions.add(index);
      queryIndex++;
    }
  });
  return queryIndex === Array.from(needle).length ? positions : new Set<number>();
}

export function orderedArtists(artists: LibraryArtist[]): LibraryArtist[] {
  return [...artists].sort((a, b) => {
    const saved = (b.lastSavedAt ? Date.parse(b.lastSavedAt) : 0) - (a.lastSavedAt ? Date.parse(a.lastSavedAt) : 0);
    return (Number.isFinite(saved) ? saved : 0) || b.assetCount - a.assetCount || artistName(a).localeCompare(artistName(b), 'ko');
  });
}

export function sortArtists(artists: LibraryArtist[], sort: ArtistSort): LibraryArtist[] {
  return [...artists].sort((a, b) => {
    if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;

    if (sort === 'recent') {
      const aTime = a.lastSavedAt ? Date.parse(a.lastSavedAt) : NaN;
      const bTime = b.lastSavedAt ? Date.parse(b.lastSavedAt) : NaN;
      const aMissing = !Number.isFinite(aTime);
      const bMissing = !Number.isFinite(bTime);
      if (aMissing !== bMissing) return aMissing ? 1 : -1;
      if (!aMissing && aTime !== bTime) return bTime - aTime;
    } else if (sort === 'count' && a.assetCount !== b.assetCount) {
      return b.assetCount - a.assetCount;
    }

    return artistName(a).localeCompare(artistName(b), 'ko');
  });
}

/** The server currently publishes tiers, not a separate today's-picks array. */
export function todayArtists(artists: LibraryArtist[]): LibraryArtist[] {
  const ranked = [...artists].sort((a, b) => Number(b.main) - Number(a.main) || Number(b.pinned) - Number(a.pinned));
  return [...new Map(ranked.map(artist => [artist.id, artist])).values()].slice(0, 3);
}

export function daysSince(value: string | null | undefined, now = Date.now()): number | null {
  if (!value) return null;
  const time = Date.parse(value);
  if (!Number.isFinite(time) || time > now) return null;
  return Math.floor((now - time) / 86_400_000);
}

export function dateText(value: string | null | undefined, includeYear = true): string {
  if (!value) return '';
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return '';
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return includeYear ? `${year}.${month}.${day}` : `${month}.${day}`;
}

export function profileUrl(artist: LibraryArtist): string | null {
  const candidates = [...artist.keys, artist.sourceName ?? ''];
  for (const candidate of candidates) {
    if (/^https:\/\/(?:www\.)?(?:pixiv\.net|x\.com|twitter\.com)\//i.test(candidate)) return candidate;
    const pixiv = candidate.match(/^pixiv:(\d+)$/i);
    if (pixiv) return `https://www.pixiv.net/users/${pixiv[1]}`;
    const x = candidate.match(/^x:(@?[A-Za-z0-9_.-]+)$/i);
    if (x) return `https://x.com/${x[1].replace(/^@/, '')}`;
    if (/^@?[A-Za-z0-9_.-]{2,80}$/.test(candidate) && !candidate.includes('.')) return `https://x.com/${candidate.replace(/^@/, '')}`;
  }
  return null;
}
