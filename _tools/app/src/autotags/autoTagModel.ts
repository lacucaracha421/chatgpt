/**
 * Display rules for 자동 태그: Korean labels, groups, ordering, guessed characters and search.
 * Pure functions; the inspector, the 찾기 palette and the filter badges share them.
 */
import { AUTO_TAG_DICTIONARY, CHARACTER_SERIES, COMMON_TAGS, HIDDEN_TAGS, SERIES_LABELS, type AutoTagDisplayGroup } from "./dictionary";
import type { AssetAutoTag, AssetAutoTags, AutoTagCategory, AutoTagVocabularyEntry } from "./types";

/** A machine character tag is shown (as 추정) only this confident and only without a confirmed character. */
export const CHARACTER_MIN_SCORE = 0.85;

export type AutoTagGroupKey = "character" | AutoTagDisplayGroup;

export const AUTO_TAG_GROUPS: readonly { key: AutoTagGroupKey; label: string }[] = [
  { key: "character", label: "캐릭터 (추정)" },
  { key: "body", label: "인물·외모" },
  { key: "wear", label: "옷·소품" },
  { key: "pose", label: "표정·포즈" },
  { key: "sex", label: "성적 표현" },
  { key: "scene", label: "장면·배경" },
  { key: "etc", label: "기타" },
];

export type AutoTagChip = {
  tag: string;
  label: string;
  group: AutoTagGroupKey;
  /** Frequent, low-information tag: shown last and dimmed. */
  common: boolean;
  /** A machine guess of a character (추정). */
  guessed: boolean;
  source: AssetAutoTag["source"];
  score: number | null;
};

export type AutoTagChipGroup = { key: AutoTagGroupKey; label: string; chips: AutoTagChip[] };

export type AutoTagView = {
  /** Guessed characters for the 주요 태그 row. */
  characters: AutoTagChip[];
  groups: AutoTagChipGroup[];
  total: number;
};

const humanize = (name: string) => name.replace(/_/g, " ").trim();

/** `ellen_joe` → `Ellen Joe`; keeps digits and symbols. */
export function prettifyName(name: string) {
  return humanize(name).split(/\s+/).map((word) => word.charAt(0).toLocaleUpperCase() + word.slice(1)).join(" ");
}

/** Splits trailing Danbooru qualifiers: `elysia_(a)_(honkai_impact)` → `elysia`, [`honkai_impact`, `a`]. */
function splitQualifiers(tag: string): { base: string; qualifiers: string[] } {
  let base = tag;
  const qualifiers: string[] = [];
  for (;;) {
    const match = /_\(([^()]+)\)$/.exec(base);
    if (!match || match.index === 0) break;
    qualifiers.push(match[1]);
    base = base.slice(0, match.index);
  }
  return { base, qualifiers };
}

/** The series of a character tag, from its qualifier or the explicit map; null when unknown. */
export function characterSeries(tag: string): string | null {
  const { base, qualifiers } = splitQualifiers(tag);
  const mapped = qualifiers.find((qualifier) => qualifier in SERIES_LABELS);
  const key = mapped ?? CHARACTER_SERIES[base] ?? qualifiers[0] ?? null;
  return key ? SERIES_LABELS[key] ?? prettifyName(key) : null;
}

export function characterName(tag: string) {
  return prettifyName(splitQualifiers(tag).base);
}

/** Korean label when the dictionary has one; otherwise the Danbooru name with spaces. */
export function autoTagLabel(tag: string, category: AutoTagCategory = "general") {
  if (category === "character") return characterName(tag);
  return AUTO_TAG_DICTIONARY.get(tag)?.ko ?? humanize(tag);
}

/** The English (Danbooru) name shown on hover. */
export const autoTagEnglish = humanize;

export function isDisplayedAutoTag(tag: string, category: AutoTagCategory) {
  return category !== "meta" && category !== "rating" && category !== "artist" && !HIDDEN_TAGS.has(tag);
}

function groupOf(tag: string, category: AutoTagCategory): AutoTagGroupKey {
  if (category === "character") return "character";
  return AUTO_TAG_DICTIONARY.get(tag)?.group ?? "etc";
}

/** User-added tags first, then by score; common tags always after the rest. */
function compareChips(left: AutoTagChip, right: AutoTagChip) {
  if (left.common !== right.common) return left.common ? 1 : -1;
  return (right.score ?? 2) - (left.score ?? 2) || left.label.localeCompare(right.label, "ko");
}

export function buildAutoTagView({ tags, hasConfirmedCharacter }: AssetAutoTags): AutoTagView {
  const chips: AutoTagChip[] = [];
  for (const tag of tags) {
    if (!isDisplayedAutoTag(tag.tag, tag.category)) continue;
    const group = groupOf(tag.tag, tag.category);
    const guessed = group === "character" && tag.source === "model";
    if (guessed && (hasConfirmedCharacter || (tag.score ?? 0) < CHARACTER_MIN_SCORE)) continue;
    chips.push({
      tag: tag.tag,
      label: autoTagLabel(tag.tag, tag.category),
      group,
      common: COMMON_TAGS.has(tag.tag),
      guessed,
      source: tag.source,
      score: tag.score,
    });
  }
  chips.sort(compareChips);
  const groups = AUTO_TAG_GROUPS
    .map(({ key, label }) => ({ key, label, chips: chips.filter((chip) => chip.group === key) }))
    .filter((group) => group.chips.length > 0);
  return {
    characters: chips.filter((chip) => chip.guessed),
    groups,
    total: chips.length,
  };
}

const normalize = (text: string) => text.toLocaleLowerCase().replace(/[\s_]+/g, "");

export type AutoTagSearchResult = AutoTagVocabularyEntry & { label: string };

/**
 * Vocabulary matches for typed Korean or English, best first: exact, then prefix, then
 * substring; ties by library count. Hidden and meta tags never match.
 */
export function searchAutoTags(entries: readonly AutoTagVocabularyEntry[], query: string, { limit = 8, minCount = 0 } = {}): AutoTagSearchResult[] {
  const needle = normalize(query);
  if (!needle) return [];
  const scored: { entry: AutoTagSearchResult; rank: number }[] = [];
  for (const entry of entries) {
    if (entry.count < minCount || !isDisplayedAutoTag(entry.tag, entry.category)) continue;
    const label = entry.category === "character" ? characterName(entry.tag) : autoTagLabel(entry.tag, entry.category);
    let rank = Infinity;
    for (const name of [normalize(label), normalize(entry.tag)]) {
      const at = name.indexOf(needle);
      if (at < 0) continue;
      rank = Math.min(rank, name === needle ? 0 : at === 0 ? 1 : 2);
    }
    if (rank !== Infinity) scored.push({ entry: { ...entry, label }, rank });
  }
  scored.sort((left, right) => left.rank - right.rank || right.entry.count - left.entry.count || left.entry.tag.localeCompare(right.entry.tag));
  return scored.slice(0, limit).map(({ entry }) => entry);
}
