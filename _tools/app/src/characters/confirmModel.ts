import type { CharacterTarget } from "./api";
import type { ShadowReviewItem } from "./shadowReviewApi";
import type { TaggerReviewItem } from "./taggerReviewClient";

/**
 * One 확인 list holds three kinds of items, each named in plain words:
 * - `tag` 태그 추천: the automatic tags read this character's name on an image nobody placed yet;
 * - `recognition` 인식 추천: 기본/학습 인식 suggest this character;
 * - `recheck` 다시 확인: an automatic placement that the tags or 학습 인식 doubt.
 * An image the tags and the recognition both bring up is shown once.
 */
export type ConfirmKind = "recognition" | "tag" | "recheck";
export const CONFIRM_KINDS: readonly ConfirmKind[] = ["recognition", "tag", "recheck"];
export const confirmKindLabel: Record<ConfirmKind, string> = { recognition: "인식 추천", tag: "태그 추천", recheck: "다시 확인" };

export type ConfirmCrop = { box: [number, number, number, number]; distance: number };

export type ConfirmItem = {
  /** One image of one character. */
  key: string;
  kind: ConfirmKind;
  assetId: string;
  originalName: string;
  width: number;
  height: number;
  targetId: string;
  targetName: string;
  seriesId: string | null;
  targetFingerprint: string;
  /** Present when the automatic tags brought the image up. */
  tags: { reason: "recommendation" | "veto"; sure: boolean } | null;
  /** Present when 기본/학습 인식 brought the image up: "doubtful" is a placement 학습 인식 does not support. */
  recognition: { verdict: ShadowReviewItem["verdict"]; doubtful: boolean; placed: boolean } | null;
  referenceAssetIds: string[];
  /** The person-box 기본 인식 found; only the tag list carries it. */
  crop: ConfirmCrop | null;
  /** The tag list read the image's folder placement separately, so a 맞음 may have to move it. */
  fromTags: TaggerReviewItem | null;
};
export type ConfirmCounts = Record<ConfirmKind, number> & { total: number };

export const confirmKey = (targetId: string, assetId: string) => `${targetId}\u0000${assetId}`;
const SURE = 0.85;

export function emptyConfirmCounts(): ConfirmCounts {
  return { recognition: 0, tag: 0, recheck: 0, total: 0 };
}
export function confirmCounts(items: readonly Pick<ConfirmItem, "kind">[]): ConfirmCounts {
  const counts = emptyConfirmCounts();
  for (const item of items) { counts[item.kind] += 1; counts.total += 1; }
  return counts;
}

/** Whole-image evidence of the tagger projection: 확실 when both automatic tags read the name firmly. */
const tagsSure = (item: TaggerReviewItem) => item.evidence.pixaiScore >= SURE && item.evidence.canaryScore >= SURE;

function referencesOf(target: CharacterTarget | undefined): string[] {
  return target?.references.flatMap(reference => reference.status === "ready" && reference.assetId ? [reference.assetId] : []).slice(0, 4) ?? [];
}

type MergeInput = {
  tagger: readonly TaggerReviewItem[];
  /** 인식 추천: pending automatic and recommended candidates. */
  candidates: readonly ShadowReviewItem[];
  /** 다시 확인 by 학습 인식: automatic placements it does not support. */
  doubtful: readonly ShadowReviewItem[];
  targets: readonly CharacterTarget[];
};

const RANK: Record<ConfirmKind, number> = { recognition: 0, tag: 1, recheck: 2 };

/**
 * The three lists as one, deduplicated by (character, image). Within a kind the sources' own order is
 * kept (the recognition list puts its sure candidates first); kinds follow 인식 추천, 태그 추천, 다시 확인.
 */
export function mergeConfirmItems({ tagger, candidates, doubtful, targets }: MergeInput): ConfirmItem[] {
  const byTarget = new Map(targets.map(target => [target.id, target]));
  const merged = new Map<string, ConfirmItem>();
  const seriesOf = (targetId: string) => byTarget.get(targetId)?.seriesClassificationId ?? null;
  const base = (item: { assetId: string; originalName: string; width: number; height: number; targetId: string; targetName: string; targetFingerprint: string }): ConfirmItem => ({
    key: confirmKey(item.targetId, item.assetId), kind: "recognition", assetId: item.assetId, originalName: item.originalName, width: item.width, height: item.height,
    targetId: item.targetId, targetName: item.targetName, seriesId: seriesOf(item.targetId), targetFingerprint: item.targetFingerprint,
    tags: null, recognition: null, referenceAssetIds: [], crop: null, fromTags: null,
  });
  const addShadow = (item: ShadowReviewItem, isDoubtful: boolean) => {
    const key = confirmKey(item.targetId, item.assetId);
    const row = merged.get(key) ?? base(item);
    row.recognition = { verdict: item.verdict, doubtful: isDoubtful, placed: item.nativeOutcome === "accepted_automatic" };
    row.targetFingerprint = item.targetFingerprint;
    if (item.referenceAssetIds.length) row.referenceAssetIds = item.referenceAssetIds;
    merged.set(key, row);
  };
  for (const item of candidates) addShadow(item, false);
  for (const item of tagger) {
    const key = confirmKey(item.targetId, item.asset.id);
    const row = merged.get(key) ?? base({ assetId: item.asset.id, originalName: item.asset.originalName, width: item.asset.width, height: item.asset.height, targetId: item.targetId, targetName: item.targetName, targetFingerprint: item.targetFingerprint });
    row.tags = { reason: item.evidence.reason, sure: tagsSure(item) };
    row.crop = item.crop ?? null;
    row.fromTags = item;
    row.seriesId = item.seriesId || row.seriesId;
    merged.set(key, row);
  }
  for (const item of doubtful) addShadow(item, true);
  const rows = [...merged.values()].map(row => {
    const kind: ConfirmKind = row.recognition?.doubtful || row.tags?.reason === "veto" ? "recheck" : row.recognition ? "recognition" : "tag";
    const referenceAssetIds = row.referenceAssetIds.length ? row.referenceAssetIds : referencesOf(byTarget.get(row.targetId));
    return { ...row, kind, referenceAssetIds };
  });
  return rows.sort((left, right) => RANK[left.kind] - RANK[right.kind]);
}

export type ConfirmTally = { targetId: string; targetName: string; seriesId: string | null; counts: ConfirmCounts };

/** The pending count of every character, in first-seen order. */
export function tallyConfirm(items: readonly ConfirmItem[]): ConfirmTally[] {
  const tallies = new Map<string, ConfirmTally>();
  for (const item of items) {
    let tally = tallies.get(item.targetId);
    if (!tally) tallies.set(item.targetId, tally = { targetId: item.targetId, targetName: item.targetName, seriesId: item.seriesId, counts: emptyConfirmCounts() });
    tally.counts[item.kind] += 1;
    tally.counts.total += 1;
  }
  return [...tallies.values()];
}

export type ConfirmCharacter = { targetId: string; name: string; counts: ConfirmCounts; thumbnailAssetId: string | null };
export type ConfirmGroup = { seriesId: string | null; seriesName: string; counts: ConfirmCounts; characters: ConfirmCharacter[] };

/** 확인 split by series and character, busiest first; a character without a known series lands in "기타" (last). */
export function confirmGroups(
  tallies: readonly ConfirmTally[],
  targets: readonly CharacterTarget[],
  seriesName: (id: string) => string | undefined,
): ConfirmGroup[] {
  const byId = new Map(targets.map(target => [target.id, target]));
  const groups = new Map<string, ConfirmGroup>();
  for (const tally of tallies) {
    if (tally.counts.total === 0) continue;
    const target = byId.get(tally.targetId);
    const seriesId = target?.seriesClassificationId ?? tally.seriesId ?? null;
    const key = seriesId ?? "";
    let group = groups.get(key);
    if (!group) groups.set(key, group = { seriesId, seriesName: (seriesId && seriesName(seriesId)) || "기타", counts: emptyConfirmCounts(), characters: [] });
    for (const kind of CONFIRM_KINDS) group.counts[kind] += tally.counts[kind];
    group.counts.total += tally.counts.total;
    group.characters.push({ targetId: tally.targetId, name: tally.targetName, counts: tally.counts,
      thumbnailAssetId: target?.thumbnailAssetId ?? target?.references.find(reference => reference.status === "ready" && reference.assetId)?.assetId ?? null });
  }
  const result = [...groups.values()];
  for (const group of result) group.characters.sort((a, b) => b.counts.total - a.counts.total || a.name.localeCompare(b.name, "ko"));
  return result.sort((a, b) => Number(a.seriesId === null) - Number(b.seriesId === null) || b.counts.total - a.counts.total || a.seriesName.localeCompare(b.seriesName, "ko"));
}

/** "태그 추천 3 · 인식 추천 2": only the kinds that have items. */
export function confirmSplitText(counts: ConfirmCounts): string {
  return CONFIRM_KINDS.filter(kind => counts[kind] > 0).map(kind => `${confirmKindLabel[kind]} ${counts[kind].toLocaleString()}`).join(" · ");
}
