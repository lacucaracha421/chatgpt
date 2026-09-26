import { disassembleToGroups, getChoseong } from "es-hangul";

/**
 * Korean-aware client-side search shared by the desktop app and the tablet client.
 *
 * - Case, whitespace and Unicode form (NFC) are ignored.
 * - A query made of consonants only (with optional Latin/digits) also matches by
 *   초성: "ㅅㄹ" finds 서리.
 * - A query containing Hangul also matches jamo by jamo from a syllable start, so a
 *   syllable still being composed matches: "갈" finds 가락, "닭" finds 달걀.
 * - Whitespace-separated words must all match (in any field, in any order).
 */
export type SearchFields = string | null | undefined | readonly (string | null | undefined)[];

type Key = { compact: string; choseong?: string; jamo?: string; starts?: Uint8Array };

const HANGUL = /[ᄀ-ᇿㄱ-ㆎ가-힣]/;
const VOWEL_OR_SYLLABLE = /[ㅏ-ㆎ가-힣]/;
const CACHE_LIMIT = 50_000;
const cache = new Map<string, Key>();

/** Lower-cased, NFC, whitespace removed: the form every comparison uses. */
export function normalizeSearchText(text: string): string {
  return text.normalize("NFC").toLowerCase().replace(/\s+/g, "");
}

function keyOf(text: string): Key {
  let key = cache.get(text);
  if (!key) {
    if (cache.size >= CACHE_LIMIT) cache.clear();
    key = { compact: normalizeSearchText(text) };
    cache.set(text, key);
  }
  return key;
}

function choseongOf(key: Key): string {
  // Complete syllables become their initial consonant; everything else stays as written.
  return (key.choseong ??= getChoseong(key.compact, { keepNonHangul: true }));
}

function jamoOf(key: Key): { jamo: string; starts: Uint8Array } {
  if (key.jamo === undefined || key.starts === undefined) {
    const groups = disassembleToGroups(key.compact);
    let jamo = "";
    const flags: number[] = [];
    for (const group of groups) group.forEach((part, index) => { jamo += part; flags.push(index === 0 ? 1 : 0); });
    key.jamo = jamo;
    key.starts = Uint8Array.from(flags);
  }
  return { jamo: key.jamo, starts: key.starts };
}

type Token = { text: string; mode: "plain" | "choseong" | "jamo"; jamo: string };

function tokenMatches(token: Token, key: Key): boolean {
  if (key.compact.includes(token.text)) return true;
  if (token.mode === "choseong") return choseongOf(key).includes(token.text);
  if (token.mode === "jamo") {
    const { jamo, starts } = jamoOf(key);
    for (let at = jamo.indexOf(token.jamo); at !== -1; at = jamo.indexOf(token.jamo, at + 1)) if (starts[at]) return true;
  }
  return false;
}

/** Prepares `query` once; the returned predicate is cheap to call per item. An empty query matches everything. */
export function createKoreanMatcher(query: string): (fields: SearchFields) => boolean {
  const tokens: Token[] = query.split(/\s+/).map(normalizeSearchText).filter(Boolean).map((text) => {
    if (!HANGUL.test(text)) return { text, mode: "plain", jamo: "" };
    if (!VOWEL_OR_SYLLABLE.test(text)) return { text, mode: "choseong", jamo: "" };
    return { text, mode: "jamo", jamo: disassembleToGroups(text).flat().join("") };
  });
  if (!tokens.length) return () => true;
  return (fields) => {
    const list = typeof fields === "string" ? [fields] : fields ?? [];
    const keys: Key[] = [];
    for (const field of list) if (field) keys.push(keyOf(field));
    return tokens.every((token) => keys.some((key) => tokenMatches(token, key)));
  };
}

/** One-off form of {@link createKoreanMatcher}; prefer the matcher when filtering a list. */
export function matchesKoreanSearch(fields: SearchFields, query: string): boolean {
  return createKoreanMatcher(query)(fields);
}
