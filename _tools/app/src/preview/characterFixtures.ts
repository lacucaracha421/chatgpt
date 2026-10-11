import type { AssetSummary } from "../library/types.ts";

/**
 * Browser-preview data for the character screens: one registered series (젠레스 존 제로) with two
 * groups, six characters, a series 기타 and a group 기타. Preview only; no real library is read.
 */
export const PREVIEW_CHARACTER_SERIES_ID = "class-zzz";

type Range = readonly [first: number, last: number];

const rangeIds = ([first, last]: Range) => Array.from({ length: last - first + 1 }, (_, index) => `asset-${String(first + index).padStart(3, "0")}`);

type Seed = { id: string; name: string; thumbnail: number; images: Range; extrasGroupId?: string | null; extras?: boolean };

const seeds: Seed[] = [
  { id: "t-ellen", name: "엘렌 조", thumbnail: 3, images: [1, 24] },
  { id: "t-corin", name: "코린 위크스", thumbnail: 27, images: [25, 40] },
  { id: "t-lycaon", name: "폰 라이카온", thumbnail: 43, images: [41, 58] },
  { id: "t-anby", name: "앤비 데마라", thumbnail: 61, images: [59, 80] },
  { id: "t-billy", name: "빌리 키드", thumbnail: 83, images: [81, 92] },
  { id: "t-belle", name: "벨", thumbnail: 95, images: [93, 100] },
  { id: "x-group-victoria", name: "빅토리아 가정부 서비스 기타", thumbnail: 101, images: [101, 112], extrasGroupId: "g-victoria", extras: true },
  { id: "x-group-hares", name: "카룬 토끼굴 기타", thumbnail: 113, images: [113, 112], // an empty range: this 기타 holds no images yet
    extrasGroupId: "g-hares", extras: true },
  { id: "x-group-trainees", name: "신입 조사원 기타", thumbnail: 231, images: [231, 246], extrasGroupId: "g-trainees", extras: true }, // a group that has only a 기타
  { id: "x-series", name: "젠레스 존 제로 기타", thumbnail: 121, images: [121, 160], extras: true },
];

const imagesByTarget = new Map(seeds.map(seed => [seed.id, rangeIds(seed.images)]));
const unclassified = rangeIds([161, 230]);

function target(seed: Seed) {
  const references = seed.extras ? [] : rangeIds([seed.images[0], seed.images[0] + 4]).map((assetId, slot) => ({ slot, assetId, assetHash: `hash-${assetId}`, status: "ready" }));
  return {
    id: seed.id, folderOrder: null, seriesClassificationId: PREVIEW_CHARACTER_SERIES_ID, linkedClassificationId: null,
    displayName: seed.name, description: "", thumbnailAssetId: `asset-${String(seed.thumbnail).padStart(3, "0")}`,
    enabled: !seed.extras, manualOnly: Boolean(seed.extras), revision: 3, references, learnedReferences: [], ready: !seed.extras,
    fingerprint: `fp-${seed.id}`, role: seed.extras ? "extras" : "character", extrasGroupId: seed.extrasGroupId ?? null,
    thumbnailRevisions: {},
  };
}

export const previewCharacterTargets = seeds.map(target);
const groupIds = { victoria: ["t-ellen", "t-corin", "t-lycaon"], hares: ["t-anby", "t-billy"] };
export const previewCharacterGroups = [
  { id: "g-victoria", seriesId: PREVIEW_CHARACTER_SERIES_ID, name: "빅토리아 가정부 서비스", revision: 2, targetIds: groupIds.victoria, extrasTargetId: "x-group-victoria" },
  { id: "g-hares", seriesId: PREVIEW_CHARACTER_SERIES_ID, name: "카룬 토끼굴", revision: 1, targetIds: groupIds.hares, extrasTargetId: "x-group-hares" },
  { id: "g-trainees", seriesId: PREVIEW_CHARACTER_SERIES_ID, name: "신입 조사원", revision: 1, targetIds: [] as string[], extrasTargetId: "x-group-trainees" },
];

export function previewCharacterSidebarCounts() {
  return {
    targets: Object.fromEntries(seeds.map(seed => [seed.id, imagesByTarget.get(seed.id)!.length])),
    groups: { "g-victoria": 24 + 16 + 18 + 12, "g-hares": 22 + 12, "g-trainees": 16 },
  };
}

export function previewCharacterBrowse(args: Record<string, unknown>, assets: readonly AssetSummary[]) {
  const query = (args.query ?? {}) as { targetId?: string | null; groupId?: string | null };
  let ids: string[];
  if (query.targetId) ids = imagesByTarget.get(query.targetId) ?? [];
  else if (query.groupId) {
    const group = previewCharacterGroups.find(item => item.id === query.groupId);
    ids = [...(group?.targetIds ?? []), ...(group?.extrasTargetId ? [group.extrasTargetId] : [])].flatMap(id => imagesByTarget.get(id) ?? []);
  } else ids = unclassified;
  const byId = new Map(assets.map(asset => [asset.id, asset]));
  const items = ids.flatMap(id => byId.get(id) ?? []);
  return { items, nextCursor: null, totalCount: items.length, unavailableReferenceIds: [] };
}

/** The 기타 suggestions: the series' own reads one known name on 7 images; the Victoria group's reads an unlisted name; the 기타-only group reads one known name on 6. */
export function previewExtrasSuggestions(targetId: string) {
  if (targetId === "x-series") {
    return [{ tag: "wise_(zenless_zone_zero)", imageCount: 7, bothCount: 5, pixaiCount: 6, canaryCount: 6, assetIds: rangeIds([121, 127]) }];
  }
  if (targetId === "x-group-victoria") {
    return [{ tag: "hoshimi_miyabi_(zenless_zone_zero)", imageCount: 12, bothCount: 9, pixaiCount: 11, canaryCount: 10, assetIds: rangeIds([101, 112]) }];
  }
  if (targetId === "x-group-trainees") {
    return [{ tag: "nicole_demara_(zenless_zone_zero)", imageCount: 6, bothCount: 5, pixaiCount: 6, canaryCount: 5, assetIds: rangeIds([231, 236]) }];
  }
  return [];
}

/**
 * `character_suggestions`: eight new-character suggestions in two series (the second has no registered
 * folder match for one of them), so the thumbnail cards show every folder sentence and badge shape.
 */
export function previewCharacterSuggestions(minimum: number) {
  const samples = (first: number) => rangeIds([first, first + 3]);
  const row = (tag: string, imageCount: number, bothCount: number, insideCount: number, first: number, seriesId: string | null, seriesName: string | null) =>
    ({ tag, imageCount, bothCount, pixaiCount: imageCount, canaryCount: bothCount, sampleAssetIds: samples(first), seriesId, seriesName, insideCount });
  const rows = [
    row("blonney", 9, 0, 9, 11, PREVIEW_CHARACTER_SERIES_ID, "젠레스 존 제로"),
    row("hornet_(hollow_knight)", 8, 8, 2, 21, PREVIEW_CHARACTER_SERIES_ID, "젠레스 존 제로"),
    row("sophia_(reverse:1999)", 8, 5, 8, 31, PREVIEW_CHARACTER_SERIES_ID, "젠레스 존 제로"),
    row("dairin", 9, 7, 9, 41, PREVIEW_CHARACTER_SERIES_ID, "젠레스 존 제로"),
    row("soldier_11_(zenless_zone_zero)", 9, 4, 9, 51, "class-reverse", "리버스"),
    row("ukinami_yuzuha", 9, 9, 9, 61, "class-reverse", "리버스"),
    row("koharu_rika", 5, 2, 5, 71, "class-reverse", "리버스"),
    row("belle_(swimsuit)", 8, 1, 0, 81, "class-reverse", "리버스"),
    row("canary_only_character", 6, 0, 0, 91, null, null),
  ];
  return rows.filter(item => item.imageCount >= minimum);
}

/** `?unregister=refusal` in the preview URL shows the refused variant of the 시리즈 등록 해제 dialog. */
export function previewUnregisterPreview(seriesId: string) {
  const refused = new URLSearchParams(window.location.search).get("unregister") === "refusal";
  const base = {
    seriesId, seriesName: "젠레스 존 제로", destinationId: "class-game", destinationName: "게임",
    characterCount: 6, groupCount: 2, extrasImageCount: 58, collisions: [] as string[], refusal: null as string | null,
  };
  return refused
    ? { ...base, refusal: "상위 시리즈 ‘게임’에 같은 이름의 캐릭터가 있어 등록을 해제할 수 없습니다." }
    : base;
}

/**
 * The three 확인 lists of the preview series: 태그 추천 and 다시 확인 by the automatic tags (the tag list),
 * 인식 추천 (a candidate of the recognition list; asset-162 is also read by the tags, so it carries both badges)
 * and 다시 확인 by 학습 인식 (the doubtful list).
 */
type PendingPair = { targetId: string; asset: number };
const tagPairs: (PendingPair & { reason: "recommendation" | "veto"; pixai: number; canary: number; crop?: [number, number, number, number] })[] = [
  { targetId: "t-anby", asset: 162, reason: "recommendation", pixai: 0.93, canary: 0.91, crop: [0.22, 0.12, 0.68, 0.78] },
  { targetId: "t-anby", asset: 163, reason: "recommendation", pixai: 0.88, canary: 0.62 },
  { targetId: "t-billy", asset: 164, reason: "recommendation", pixai: 0.9, canary: 0.9, crop: [0.3, 0.2, 0.7, 0.9] },
  { targetId: "t-belle", asset: 165, reason: "recommendation", pixai: 0.87, canary: 0.89 },
  { targetId: "t-ellen", asset: 10, reason: "veto", pixai: 0.12, canary: 0.1 },
  { targetId: "t-corin", asset: 30, reason: "veto", pixai: 0.2, canary: 0.08 },
];
const candidatePairs: (PendingPair & { verdict: "automatic" | "recommended"; knn3: number })[] = [
  { targetId: "t-ellen", asset: 166, verdict: "automatic", knn3: 0.31 },
  { targetId: "t-corin", asset: 168, verdict: "automatic", knn3: 0.29 },
  { targetId: "t-anby", asset: 162, verdict: "automatic", knn3: 0.27 },
  { targetId: "t-ellen", asset: 167, verdict: "recommended", knn3: 0.44 },
  { targetId: "t-lycaon", asset: 169, verdict: "recommended", knn3: 0.47 },
];
const doubtfulPairs: PendingPair[] = [{ targetId: "t-billy", asset: 85 }, { targetId: "t-ellen", asset: 12 }];
const assetId = (number: number) => `asset-${String(number).padStart(3, "0")}`;
const targetOf = (id: string) => previewCharacterTargets.find(item => item.id === id)!;

export function previewTaggerReviewItems(assets: readonly AssetSummary[]) {
  const byId = new Map(assets.map(asset => [asset.id, asset]));
  return tagPairs.map(pair => ({
    asset: byId.get(assetId(pair.asset))!, seriesId: PREVIEW_CHARACTER_SERIES_ID, targetId: pair.targetId, targetName: targetOf(pair.targetId).displayName, targetFingerprint: targetOf(pair.targetId).fingerprint,
    evidence: { source: "tagger", reason: pair.reason, pixaiScore: pair.pixai, canaryScore: pair.canary },
    crop: pair.crop ? { box: pair.crop, distance: 0.31 } : null,
  }));
}
export const previewTaggerCounts = () => ({ total: tagPairs.length, recommendation: tagPairs.filter(pair => pair.reason === "recommendation").length, veto: tagPairs.filter(pair => pair.reason === "veto").length });

function shadowItem(pair: PendingPair, verdict: "automatic" | "recommended" | "none", knn3: number | null, native: string, assets: readonly AssetSummary[]) {
  const asset = assets.find(item => item.id === assetId(pair.asset))!;
  const target = targetOf(pair.targetId);
  return {
    assetId: asset.id, contentHash: `hash-${asset.id}`, originalName: asset.originalName, width: asset.width, height: asset.height,
    targetId: target.id, targetName: target.displayName, targetFingerprint: target.fingerprint,
    referenceAssetIds: target.references.slice(0, 4).map(reference => reference.assetId), verdict, origin: "live", knn3, nativeOutcome: native, scoredAt: "2026-10-11T03:00:00.000Z",
  };
}
const judgedCounts = { automatic: { accepted: 290, rejected: 12 }, recommended: { accepted: 59, rejected: 23 }, doubtful: { accepted: 69, rejected: 2 } };
/** `character_shadow_review_page`: the candidate list, or the doubtful list for `mode: "doubtful"`; `seriesId` keeps this series only. */
export function previewShadowReviewPage(query: { offset?: number; limit?: number; mode?: string; seriesId?: string }, assets: readonly AssetSummary[]) {
  const doubtful = query.mode === "doubtful";
  const inSeries = !query.seriesId || query.seriesId === PREVIEW_CHARACTER_SERIES_ID;
  const all = !inSeries ? [] : doubtful
    ? doubtfulPairs.map(pair => shadowItem(pair, "none", null, "accepted_automatic", assets))
    : candidatePairs.map(pair => shadowItem(pair, pair.verdict, pair.knn3, "none", assets));
  const offset = query.offset ?? 0, limit = query.limit ?? 40;
  const zero = { pending: 0, accepted: 0, rejected: 0 };
  const pending = (verdict: "automatic" | "recommended") => candidatePairs.filter(pair => inSeries && pair.verdict === verdict).length;
  const tiers = { automatic: { pending: doubtful ? 0 : pending("automatic"), ...judgedCounts.automatic }, recommended: { pending: doubtful ? 0 : pending("recommended"), ...judgedCounts.recommended } };
  return {
    items: all.slice(offset, offset + limit), nextOffset: offset + limit < all.length ? offset + limit : null, policyVersion: "s36-knn3-v2",
    summary: { ...tiers, byOrigin: { live: tiers, backfill: { automatic: zero, recommended: zero } }, doubtful: { pending: doubtful && inSeries ? doubtfulPairs.length : 0, ...judgedCounts.doubtful } },
  };
}
export function previewShadowReviewSummary() {
  const targets = new Map<string, { targetId: string; targetName: string; automatic: number; recommended: number }>();
  for (const pair of candidatePairs) {
    const row = targets.get(pair.targetId) ?? { targetId: pair.targetId, targetName: targetOf(pair.targetId).displayName, automatic: 0, recommended: 0 };
    row[pair.verdict] += 1;
    targets.set(pair.targetId, row);
  }
  return { automatic: candidatePairs.filter(pair => pair.verdict === "automatic").length, recommended: candidatePairs.filter(pair => pair.verdict === "recommended").length, targets: [...targets.values()] };
}
/** 확인 판단 / 맞음 예시 / 틀림 of the characters (the learning line is 30 and 50). */
export function previewS36Readiness() {
  const rows: [string, number, number, number, string][] = [
    ["t-ellen", 74, 0, 126, "ready"], ["t-corin", 44, 2, 97, "ready"], ["t-lycaon", 36, 3, 42, "hold"],
    ["t-anby", 46, 5, 111, "keep"], ["t-billy", 12, 0, 40, "collecting"], ["t-belle", 0, 0, 8, "collecting"],
  ];
  return rows.map(([targetId, reviewed, wrong, examples, status]) => ({ targetId, reviewed, wrong, examples, status }));
}
/** `character_confirm_counts`: each pair once under its highest kind (the tags and 학습 인식 doubting a placement beat a recognition suggestion). */
export function previewConfirmCounts(seriesId?: string | null) {
  const counts = { recognition: 0, tag: 0, recheck: 0 };
  if (seriesId && seriesId !== PREVIEW_CHARACTER_SERIES_ID) return counts;
  const kinds = new Map<string, "recognition" | "tag" | "recheck">();
  const key = (pair: PendingPair) => `${pair.targetId}:${pair.asset}`;
  for (const pair of tagPairs) kinds.set(key(pair), pair.reason === "veto" ? "recheck" : "tag");
  for (const pair of candidatePairs) if (kinds.get(key(pair)) !== "recheck") kinds.set(key(pair), "recognition");
  for (const pair of doubtfulPairs) kinds.set(key(pair), "recheck");
  for (const kind of kinds.values()) counts[kind] += 1;
  return counts;
}
