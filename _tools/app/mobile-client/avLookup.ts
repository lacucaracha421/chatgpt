const PRODUCT_CODE_PREFIX = String.raw`(?:\d{1,4}[A-Za-z]{2,6}|[A-Za-z]{2,6}\d(?:[A-Za-z]{2,6}|[-\s][A-Za-z]{2,6})?|[A-Za-z]{2,6})`;
const PRODUCT_CODE_EXACT_RE = new RegExp(`^${PRODUCT_CODE_PREFIX.replace(/\[A-Za-z\]/g, '[A-Z]')}[-\\s]?\\d{2,7}[A-Z]?$`);

export const AV_LOOKUP_RECENT_KEY = 'lakomics.mobile.avLookupRecent';

export type AvLookupRecent = {code: string; sentAt: string};

export function collapseWhitespace(value: unknown): string {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

function canonicalPrefix(value: string): string {
  const prefix = value.replace(/\s+/g, '-').replace(/-+/g, '-');
  const embedded = prefix.match(/^([A-Z]{2,6}\d)([A-Z]{2,6})$/);
  return embedded ? `${embedded[1]}-${embedded[2]}` : prefix;
}

/** Matches the collector's product-code normalisation exactly. */
export function normalizeProductCode(value: unknown): string {
  const text = collapseWhitespace(value).toUpperCase();
  if (!PRODUCT_CODE_EXACT_RE.test(text)) return '';
  const match = text.match(/^(.+?)[-\s]?(\d{2,7})([A-Z]?)$/);
  if (!match) return '';
  return `${canonicalPrefix(match[1]!)}-${match[2]}${match[3]}`;
}

export function readAvLookupRecent(): AvLookupRecent[] {
  try {
    const raw = localStorage.getItem(AV_LOOKUP_RECENT_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((entry): entry is AvLookupRecent =>
      !!entry && typeof entry === 'object' && typeof (entry as AvLookupRecent).code === 'string'
      && typeof (entry as AvLookupRecent).sentAt === 'string').slice(0, 5);
  } catch {
    return [];
  }
}

export function writeAvLookupRecent(entries: AvLookupRecent[]): void {
  try {
    localStorage.setItem(AV_LOOKUP_RECENT_KEY, JSON.stringify(entries.slice(0, 5)));
  } catch {
    // A private or full storage area must not block sending the request.
  }
}
