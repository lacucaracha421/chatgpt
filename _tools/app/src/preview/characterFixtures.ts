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
];

export function previewCharacterSidebarCounts() {
  return {
    targets: Object.fromEntries(seeds.map(seed => [seed.id, imagesByTarget.get(seed.id)!.length])),
    groups: { "g-victoria": 24 + 16 + 18 + 12, "g-hares": 22 + 12 },
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

/** The 기타 suggestions: the series' own reads one known name on 7 images; the Victoria group's reads an unlisted name. */
export function previewExtrasSuggestions(targetId: string) {
  if (targetId === "x-series") {
    return [{ tag: "wise_(zenless_zone_zero)", imageCount: 7, bothCount: 5, pixaiCount: 6, canaryCount: 6, assetIds: rangeIds([121, 127]) }];
  }
  if (targetId === "x-group-victoria") {
    return [{ tag: "hoshimi_miyabi_(zenless_zone_zero)", imageCount: 12, bothCount: 9, pixaiCount: 11, canaryCount: 10, assetIds: rangeIds([101, 112]) }];
  }
  return [];
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
