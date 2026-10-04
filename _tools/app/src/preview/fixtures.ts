import type { AssetQuery, AssetSummary, CollectionSummary, ReleaseTitle, MangaIndexIdentity } from "../library/types.ts";
import type { ArtistSummary } from "../artists/types.ts";

export const PREVIEW_FIXTURE_MARKER = "lakomics-preview-fixture-20260929";

let mangaPins: MangaIndexIdentity[] = [];
let vanishedPreview = [{ name: "옛 폴더", relativePath: "옛 폴더", seriesCount: 2, seriesIds: [] as string[] }];

const isoDays = [
  "2026-09-29", "2026-09-28", "2026-09-27", "2026-09-25", "2026-09-22",
  "2026-09-18", "2026-09-12", "2026-09-05", "2026-08-24", "2026-08-11",
];
const creatorNames = ["모래빛", "새벽 우체국", "Lune", "초록유리", "Mina K.", "파도상점", "Rin", "윤슬", "noon", "Studio Podo"];
const creatorHandles = ["@sandlight", "@dawnpost", "@lune_draws", "@green_glass", "@mina_k", "@wave_shop", "@rinillust", "@yoonseul", "@noon_pic", "@studiopodo"];
const dimensions = [[1200, 1600], [1600, 1000], [1280, 1280], [900, 1600], [1920, 1080], [1400, 1050], [1080, 1440]] as const;

export const previewAssets: AssetSummary[] = Array.from({ length: 300 }, (_, index) => {
  const number = index + 1;
  const [width, height] = dimensions[index % dimensions.length]!;
  const creatorIndex = index % creatorNames.length;
  const date = isoDays[index % isoDays.length]!;
  const video = number % 17 === 0;
  return {
    id: `asset-${String(number).padStart(3, "0")}`,
    title: number % 4 === 0 ? `빛과 도시 ${number}` : null,
    originalName: `preview-${String(number).padStart(3, "0")}.${video ? "mp4" : "jpg"}`,
    byteSize: 420_000 + number * 31_337,
    width,
    height,
    collectedAt: `${date}T${String(8 + (index % 12)).padStart(2, "0")}:${String((index * 7) % 60).padStart(2, "0")}:00.000Z`,
    favorite: number % 9 === 0,
    sourceUrl: number % 6 === 0 ? `https://example.com/posts/${number}` : `https://x.com/${creatorHandles[creatorIndex]!.slice(1)}/status/${2609000000 + number}`,
    sourcePublishedAt: `${date}T03:20:00.000Z`,
    creatorName: creatorNames[creatorIndex]!,
    creatorHandle: creatorHandles[creatorIndex]!,
    creatorUrl: `https://x.com/${creatorHandles[creatorIndex]!.slice(1)}`,
    importSource: number % 5 === 0 ? "browser_extension" : "direct",
    importBatchId: `preview-batch-${Math.floor(index / 6)}`,
    originalModifiedAt: `${date}T03:22:00.000Z`,
    media: video ? { kind: "video", durationMs: 18_000 + number * 733, preparationState: "ready", scrubFrameCount: 24 } : { kind: number % 29 === 0 ? "gif" : "image" },
    thumbnailRevision: `preview-${number}`,
  };
});

export const previewClassifications = [
  { id: "class-game", kind: "root", name: "게임", parentId: null, iconKey: "game", colorKey: "violet", assetCount: 0, totalAssetCount: 126 },
  { id: "class-reverse", kind: "work", name: "리버스: 1999", parentId: "class-game", iconKey: null, colorKey: "violet", assetCount: 42, totalAssetCount: 42 },
  { id: "class-zzz", kind: "work", name: "젠레스 존 제로", parentId: "class-game", iconKey: null, colorKey: "amber", assetCount: 39, totalAssetCount: 39 },
  { id: "class-blue", kind: "work", name: "블루 아카이브", parentId: "class-game", iconKey: null, colorKey: "blue", assetCount: 45, totalAssetCount: 45 },
  { id: "class-manga", kind: "root", name: "만화", parentId: null, iconKey: "book", colorKey: "rose", assetCount: 0, totalAssetCount: 68 },
  { id: "class-yuri", kind: "tag", name: "백합", parentId: "class-manga", iconKey: null, colorKey: "rose", assetCount: 68, totalAssetCount: 68 },
  { id: "class-original", kind: "root", name: "오리지널", parentId: null, iconKey: "sparkles", colorKey: "mint", assetCount: 106, totalAssetCount: 106 },
] as const;

export const previewAlbums = [
  { id: "album-favorites", name: "이번 달의 장면", parentId: null, iconKey: "star", colorKey: "amber", assetCount: 24 },
  { id: "album-color", name: "푸른 색감", parentId: null, iconKey: "palette", colorKey: "blue", assetCount: 37 },
  { id: "album-reference", name: "인물 레퍼런스", parentId: null, iconKey: "portrait", colorKey: "rose", assetCount: 18 },
];

const collectionNames: Record<CollectionSummary["type"], string[]> = {
  game: ["리버스: 1999", "젠레스 존 제로", "클레르 옵스퀴르", "Hades II", "동물의 숲", "페르소나 3", "산나비", "발더스 게이트 3", "Stardew Valley", "용과 같이 8", "Spiritfarer", "GRIS"],
  manga: ["별과 바다 사이", "안녕, 에리", "룩 백", "던전밥", "스킵과 로퍼", "메달리스트", "봇치 더 록!", "블루 피리어드", "최애의 아이", "나의 백합은 일입니다!", "플라네테스", "요츠바랑!"],
  movie: ["퍼펙트 데이즈", "패스트 라이브즈", "애프터썬", "듄: 파트 2", "헤어질 결심", "에브리씽 에브리웨어", "괴물", "드라이브 마이 카", "그랜드 부다페스트 호텔", "아노라", "로봇 드림", "플로우"],
  av: ["시네마 아카이브 01", "스튜디오 컬렉션 02", "여름 기록", "도쿄 나이트", "필름 셀렉션", "오후의 장면", "클래식 모음", "겨울 특집", "디렉터스 컷", "베스트 10", "아카이브 블루", "스페셜 에디션"],
};

export const previewCollections: CollectionSummary[] = (Object.keys(collectionNames) as CollectionSummary["type"][]).flatMap((type, typeIndex) =>
  collectionNames[type].map((name, index) => {
    const id = `${type}-${index + 1}`;
    const year = 2015 + ((index + typeIndex * 2) % 12);
    return {
      id,
      name,
      description: `${name}의 이미지와 자료를 모은 preview 컬렉션입니다.`,
      type,
      coverAssetId: previewAssets[(typeIndex * 61 + index * 7) % previewAssets.length]!.id,
      selectedWorkArtworkId: `artwork-${id}-cover`,
      selectedHeroArtworkId: `artwork-${id}-hero`,
      selectedBackdropArtworkId: type === "movie" ? `artwork-${id}-backdrop` : null,
      assetCount: 10 + ((index * 7 + typeIndex) % 21),
      unreadReleaseCount: type === "manga" && index < 3 ? index + 1 : 0,
      year,
      originalTitle: index % 3 === 0 ? `${name} Original Title` : null,
      runtimeMinutes: type === "movie" ? 96 + index * 3 : null,
      author: type === "manga" ? ["아오이 하루", "야마모토 렌", "김윤하"][index % 3]! : null,
      developer: type === "game" ? ["Blue Harbor", "Studio Lantern", "Small Moon"][index % 3]! : null,
      publisher: type === "game" || type === "manga" ? ["Podo Games", "달빛출판", "Orbit Works"][index % 3]! : null,
      platforms: type === "game" ? ["PC · PS5", "PC · Xbox Series", "Switch · PC"][index % 3]! : null,
      productionCompany: type === "movie" ? ["Mori Film", "A24", "Neon River"][index % 3]! : null,
      releaseDate: `${year}-${String((index % 9) + 1).padStart(2, "0")}-${String((index % 24) + 1).padStart(2, "0")}`,
      director: type === "movie" ? ["고레에다 히로카즈", "셀린 송", "샬럿 웰스"][index % 3]! : null,
      externalScore: type === "game" || type === "movie" ? 78 + (index % 15) : null,
      myScore: index % 4 === 0 ? 4.5 : index % 4 === 1 ? 4 : null,
      genres: type === "game" ? "Adventure, RPG" : type === "movie" ? "Drama, Romance" : type === "manga" ? "Drama, Slice of Life" : null,
      overview: `${name}의 대표 정보와 소장 기록을 확인할 수 있습니다.`,
      showcase: index < 4,
      showcaseOrder: index < 4 ? index : null,
      createdAt: "2026-06-01T09:00:00.000Z",
      updatedAt: `2026-09-${String(20 + (index % 9)).padStart(2, "0")}T09:00:00.000Z`,
      sourcePath: `/preview/collections/${id}`,
      minVolume: type === "manga" ? 1 : null,
      maxVolume: type === "manga" ? 8 + index : null,
      hideConnectionPrompt: true,
    };
  }),
);

const previewArtists: ArtistSummary[] = creatorNames.map((name, index) => ({
  id: `artist-${index + 1}`,
  label: name,
  displayName: name,
  sourceName: name,
  keys: [creatorHandles[index]!.slice(1), `https://x.com/${creatorHandles[index]!.slice(1)}`],
  assetCount: 44 - index * 3,
  recentCount: 2 + (index % 5),
  firstSavedAt: `2025-${String((index % 9) + 1).padStart(2, "0")}-12T08:00:00.000Z`,
  lastSavedAt: `2026-09-${String(29 - index).padStart(2, "0")}T10:00:00.000Z`,
  lastOpenedAt: index % 3 === 0 ? "2026-09-20T11:00:00.000Z" : null,
  pinned: index < 2,
  hidden: false,
  reposter: index === 9,
  main: index < 7,
  coverAssetIds: [0, 1, 2, 3].map(offset => previewAssets[(index + offset * 10) % previewAssets.length]!.id),
}));

const releaseEntries: Array<ReleaseTitle & { watched: boolean }> = [
  release("igdb:1001", "game", "Project Dawn", "igdb", "2026-10-08", "exact", ["PC", "PS5"], false),
  release("tmdb:1002", "movie", "유리 정원", "tmdb", "2026-10-23", "exact", [], true),
  release("igdb:1003", "game", "Northern Lights", "igdb", "2026-10-01", "month", ["PC", "Switch"], false),
  release("tmdb:1004", "anime", "밤의 도서관", "tmdb", "2026-10-01", "quarter", [], false),
  { ...release("igdb:1005", "game", "Cloud Archive: Complete", "igdb", "2026-11-14", "exact", ["Switch 2"], true), port: true },
  release("tmdb:1006", "movie", "파란 오후", "tmdb", "2026-12-01", "month", [], false),
  release("igdb:1007", "game", "Paper Harbor", "igdb", null, "tbd", ["PC"], false),
];

function release(id: string, kind: ReleaseTitle["kind"], title: string, provider: ReleaseTitle["provider"], date: string | null, precision: ReleaseTitle["precision"], platforms: string[], watched: boolean): ReleaseTitle & { watched: boolean } {
  return { id, kind, provider, externalId: id.split(":")[1]!, title, originalTitle: null, cover: `preview-${id}`, platforms, date, precision, region: "KR", popularity: 80, dates: [{ region: "KR", platform: platforms[0] ?? "극장", date, precision }], watched };
}

const previewNotes = [
  { id: "note-checklist", title: "이번 주 정리", body: "", pinned: true, deleted: false, createdAt: "2026-09-22T09:00:00.000Z", updatedAt: "2026-09-29T08:10:00.000Z", localRevision: 3, pending: false, conflict: false, type: "checklist", color: "mint", labels: ["정리"], archived: false, items: [{ id: "c1", text: "새 컬렉션 표지 고르기", checked: true, order: "1" }, { id: "c2", text: "작가 미상 이미지 확인", checked: false, order: "2" }, { id: "c3", text: "태블릿으로 읽을 만화 보내기", checked: false, order: "3" }] },
  { id: "note-text", title: "가을에 보고 싶은 것", body: "비 오는 날의 영화\n짧은 단편 만화\n따뜻한 색감의 일러스트", pinned: true, deleted: false, createdAt: "2026-09-18T09:00:00.000Z", updatedAt: "2026-09-28T15:20:00.000Z", localRevision: 2, pending: false, conflict: false, type: "text", color: "amber", labels: ["목록"], archived: false },
  { id: "note-ledger", title: "취미 가계부", body: "", pinned: true, deleted: false, createdAt: "2026-09-01T09:00:00.000Z", updatedAt: "2026-09-29T07:30:00.000Z", localRevision: 5, pending: false, conflict: false, type: "ledger", color: "blue", labels: ["예산"], archived: false, income: 350000, incomeDay: 1, recurring: [{ id: "r1", name: "이미지 서비스 구독", amount: 12900, every: 1, unit: "month", start: "2026-01-05", trial: false, until: null, memo: "", order: "1" }], planned: [{ id: "p1", name: "단행본 세트", amount: 45000, month: "2026-10", memo: "", dropped: false, order: "1" }] },
];

const unknownCommands = new Set<string>();

export function fixtureMediaSize(pathname: string): { width: number; height: number; label: string } {
  const parts = pathname.split("/").filter(Boolean);
  const route = parts[1] ?? "media";
  const id = decodeURIComponent(parts[2] ?? "preview");
  const asset = previewAssets.find(item => item.id === id);
  if (asset) return { width: asset.width, height: asset.height, label: `${route} ${id}` };
  if (route.includes("hero") || route.includes("backdrop") || id.includes("hero") || id.includes("backdrop") || route === "collection-source-preview") return { width: 1600, height: 900, label: `${route} ${id}` };
  if (route.includes("portrait")) return { width: 800, height: 1000, label: `${route} ${id}` };
  if (route.includes("manga-page") || route.includes("remote-manga-page")) return { width: 1200, height: 1800, label: `${route} ${id}` };
  return { width: 900, height: 1200, label: `${route} ${id}` };
}

function classificationForAsset(index: number): string {
  return ["class-reverse", "class-zzz", "class-blue", "class-yuri", "class-original"][index % 5]!;
}

function listAssets(args: Record<string, unknown>) {
  const query = (args.query ?? {}) as Partial<AssetQuery>;
  let items = previewAssets.filter((asset, index) => {
    if (query.unclassifiedOnly && (index + 1) % 11 !== 0) return false;
    if (query.classificationId && classificationForAsset(index) !== query.classificationId) return false;
    if (query.albumId && index % previewAlbums.length !== previewAlbums.findIndex(album => album.id === query.albumId)) return false;
    if (query.collectionId) {
      const collectionIndex = previewCollections.findIndex(collection => collection.id === query.collectionId);
      if (collectionIndex < 0 || index % previewCollections.length !== collectionIndex) return false;
    }
    if (query.creatorKey) {
      const artistIndex = previewArtists.findIndex(artist => artist.id === query.creatorKey || artist.keys.includes(query.creatorKey!));
      if (artistIndex < 0 || index % previewArtists.length !== artistIndex) return false;
    }
    if (query.mediaKind === "images" && asset.media.kind === "video") return false;
    if (query.mediaKind === "videos" && asset.media.kind !== "video") return false;
    if (query.favoriteOnly && !asset.favorite) return false;
    if (query.aspectRatio === "portrait" && asset.width >= asset.height) return false;
    if (query.aspectRatio === "landscape" && asset.width <= asset.height) return false;
    if (query.aspectRatio === "square" && Math.abs(asset.width / asset.height - 1) > 0.15) return false;
    return true;
  });
  if (query.sort === "oldest") items = [...items].reverse();
  else if (query.sort === "favorites") items = [...items].sort((a, b) => Number(b.favorite) - Number(a.favorite));
  const start = Number.parseInt(query.after?.token ?? "0", 10) || 0;
  const limit = query.limit ?? 60;
  const page = items.slice(start, start + limit);
  return { items: page, previousCursor: start > 0 ? { token: String(Math.max(0, start - limit)) } : null, nextCursor: start + limit < items.length ? { token: String(start + limit) } : null, totalCount: items.length };
}

function catalogWorks() {
  return Array.from({ length: 36 }, (_, index) => ({
    provider: "kHentai" as const,
    providerWorkId: String(8000 + index),
    groupId: `preview-group-${index}`,
    title: `[Preview] ${["비 오는 오후", "유리별의 노래", "작은 여행", "푸른 정원", "달빛 우체국", "여름의 끝"][index % 6]} ${index + 1}`,
    titleJpn: null,
    artists: [creatorNames[index % creatorNames.length]!],
    series: [index % 2 === 0 ? "오리지널" : "단편선"],
    thumbnailUrl: `http://lakomics.localhost/catalog-cover/catalog-${index + 1}`,
    bookmarked: index % 8 === 0,
    fileCount: 18 + (index % 31),
    views: 1200 + index * 971,
    posted: 1_759_000_000 + index * 4_000,
    versionCount: 1 + (index % 3),
    hasBookmarkedVersion: index % 8 === 0,
  }));
}

export function dispatchPreviewCommand(command: string, args: Record<string, unknown>): unknown {
  switch (command) {
    case "open_library": return { root: "/preview/library" };
    case "workload_profile": return { lightweight: false, autoEnterMinutes: null, closeToTray: false, restricted: false, hidden: false, trayAvailable: false };
    case "list_classifications": return previewClassifications;
    case "list_albums": return previewAlbums;
    case "list_collections": return previewCollections;
    case "classification_sync_status":
    case "album_sync_status": return { adopted: true, libraryId: "preview-library", epoch: 1, contractVersion: 1, cursor: 48, pendingCount: 0, blockedCount: 0, waitingCount: 0, droppedCount: 0, lastDropReason: null, oldestPendingOperationId: null };
    case "list_assets": return listAssets(args);
    case "refresh_assets": return previewAssets.filter(asset => ((args.assetIds as string[] | undefined) ?? []).includes(asset.id));
    case "get_asset": return previewAssets.find(asset => asset.id === args.assetId) ?? previewAssets[0];
    case "list_asset_date_buckets": return isoDays.map(date => ({ date, count: previewAssets.filter(asset => asset.collectedAt.startsWith(date)).length }));
    case "list_asset_creators": return previewArtists.map(artist => ({ key: artist.keys[0], creatorName: artist.label, creatorHandle: `@${artist.keys[0]}`, creatorUrl: `https://x.com/${artist.keys[0]}`, assetCount: artist.assetCount, lastCollectedAt: artist.lastSavedAt, lastOpenedAt: artist.lastOpenedAt, recommendationScore: 0.9, coverAssetIds: artist.coverAssetIds }));
    case "list_source_group_assets": {
      const index = Math.max(0, previewAssets.findIndex(asset => asset.id === args.assetId));
      const start = Math.floor(index / 3) * 3;
      return previewAssets.slice(start, start + 3);
    }
    case "get_asset_classifications": {
      const index = Math.max(0, previewAssets.findIndex(asset => asset.id === args.assetId));
      return [classificationForAsset(index)];
    }
    case "get_asset_albums": return ["album-favorites"];
    case "get_asset_collections": return ["game-1"];
    case "get_asset_auto_tags": {
      const number = Number(String(args.assetId ?? "0").split("-").pop()) || 0;
      return { hasConfirmedCharacter: number % 3 === 0, tags: number % 4 === 0 ? [] : [
        { tag: "1girl", category: "general", score: 0.98, source: "model" },
        { tag: number % 3 === 0 ? "blue_archive" : "original", category: "copyright", score: 0.91, source: "model" },
        { tag: "warm_light", category: "general", score: 0.78, source: "model" },
      ] };
    }
    case "list_auto_tag_vocabulary": return [{ tag: "1girl", category: "general", count: 184 }, { tag: "original", category: "copyright", count: 91 }, { tag: "warm_light", category: "general", count: 73 }];
    case "get_auto_tag_import_summary": return { model: "preview-tagger", importedAt: "2026-09-28T04:00:00.000Z", sourceName: "preview.sqlite", taggedAssets: 218, tagRows: 1280, skippedAssets: 4 };
    case "get_home_overview": return { failed: [], assets: { total: 300, today: 30, week: 180, images: 283, videos: 17 }, collections: { game: 12, manga: 12, movie: 12, av: 12 }, tagger: { total: 6, recommendation: 4, veto: 2 }, avPerformer: null, server: { configured: true, live: true, confirmedAt: "2026-09-29T06:00:00.000Z", capturesPending: 3 } };
    case "get_revisit_slate": return { localDate: "2026-09-29", createdAt: "2026-09-29T00:00:00.000Z", revision: 1, bundles: [{ id: "revisit-date", kind: "date", title: "1년 전 오늘", reason: "지난해 오늘 저장한 그림", assetIds: previewAssets.slice(80, 88).map(asset => asset.id), revision: 1 }] };
    case "list_av_favorites": return [];
    case "get_artist_overview": return { settings: { mainMinCount: 10, recentMinCount: 3, recentDays: 30 }, total: previewArtists.length, main: 7, other: 2, twoToFour: 1, single: 0, hidden: 0, reposter: 1, styleSuggestionCount: 4, unknownNone: 12, unknownSource: 7, mergeSuggestions: 1, sourceFillable: 7, pinned: previewArtists.filter(artist => artist.pinned) };
    case "list_artists": {
      const query = (args.query ?? {}) as { search?: string; bucket?: string; offset?: number; limit?: number };
      const needle = query.search?.toLowerCase() ?? "";
      const filtered = previewArtists.filter(artist => (!needle || artist.label.toLowerCase().includes(needle) || artist.keys.some(key => key.includes(needle))) && (query.bucket !== "main" || artist.main) && (query.bucket !== "hidden" || artist.hidden) && (query.bucket !== "reposter" || artist.reposter));
      const offset = query.offset ?? 0;
      return { total: filtered.length, artists: filtered.slice(offset, offset + (query.limit ?? 100)) };
    }
    case "get_artist_today": return previewArtists.slice(0, 4).map((artist, index) => ({ artist, kind: index === 0 ? "anniversary" : index === 1 ? "unseen" : "fresh", reason: index === 0 ? "1년 전 오늘 처음 저장" : index === 1 ? "오랜만에 다시 보기" : "최근 새 그림", assetIds: artist.coverAssetIds.slice(0, 3) }));
    case "get_artist": {
      const artist = previewArtists.find(item => item.id === args.artistId) ?? previewArtists[0]!;
      return { summary: artist, members: artist.keys.map(key => ({ key, name: artist.label, host: key.startsWith("http") ? "x.com" : null, assetCount: artist.assetCount })), assignments: [{ source: "source_url", assetCount: artist.assetCount, latestAt: artist.lastSavedAt }], sources: [{ host: "x.com", count: artist.assetCount }], onThisDay: { total: 3, assetIds: artist.coverAssetIds.slice(0, 3), yearsAgo: 1, localDate: "2025-09-29" }, longUnseen: null, mergeSuggestions: [] };
    }
    case "artist_style_suggestion": return null;
    case "artist_style_status": return { features: 254, model: "preview", suggestions: 4, computing: false };
    case "list_artist_style_suggestions": return { totalImages: 4, totalArtists: 0, groups: [], upToDate: true };
    case "get_artist_caption_labels": return { byKey: Object.fromEntries(previewArtists.map(artist => [artist.keys[0], artist.label])), byAsset: {} };
    case "list_artist_merge_suggestions": return [];
    case "preview_artist_source_fill": return { total: 7, sites: [{ host: "x.com", assetCount: 7, method: "auto", fillable: 7 }], fillable: 7, withoutHandle: 0, existingArtists: 5, newArtists: 2, groups: [] };
    case "list_artist_excluded_folders": return [];
    case "get_release_calendar":
    case "refresh_release_calendar":
    case "refresh_release_calendar_now": return { rangeStart: "2026-09-29", rangeEnd: "2027-03-29", entries: releaseEntries, sources: [{ provider: "igdb", fetchedAt: "2026-09-29T03:00:00.000Z", attemptedAt: "2026-09-29T03:00:00.000Z", errorCode: null, due: false }, { provider: "tmdb", fetchedAt: "2026-09-29T03:02:00.000Z", attemptedAt: "2026-09-29T03:02:00.000Z", errorCode: null, due: false }, { provider: "tmdb_tv", fetchedAt: "2026-09-29T03:03:00.000Z", attemptedAt: "2026-09-29T03:03:00.000Z", errorCode: null, due: false }] };
    case "list_release_wishlist": return releaseEntries.filter(entry => entry.watched).map((entry, index) => ({ ...entry, source: "calendar", addedAt: "2026-09-20T09:00:00.000Z", muted: false, lastCheckedAt: "2026-09-29T03:00:00.000Z", nextCheckAt: "2026-09-30T03:00:00.000Z", released: false, unread: index === 0 ? [{ id: "wish-event-1", itemId: entry.id, kind: "date_changed", previousValue: "2026-10-30", currentValue: entry.date, detectedAt: "2026-09-29T03:00:00.000Z", readAt: null }] : [] }));
    case "run_due_release_wishlist": return { checked: 2, changed: 0, remaining: 0, stopReason: null };
    case "list_release_board": return previewCollections
      .filter(collection => collection.type === "manga")
      .map((collection, index) => ({
        collectionId: collection.id,
        releaseWatch: { enabled: index < 8, available: true },
        ownedVolumes: [{ editionIndex: 0, count: 3 + index }],
        releaseSchedule: {
          kakao: {
            editionIndex: 0,
            checkedAt: "2026-09-29T03:00:00.000Z",
            volumes: [
              { volumeNumber: 4 + index, date: `2026-${String(10 + Math.floor(index / 3)).padStart(2, "0")}-${String(8 + index).padStart(2, "0")}`, status: "upcoming" },
              { volumeNumber: 3 + index, date: "2026-08-20", status: "released" },
            ],
          },
          mangadex: {
            checkedAt: "2026-09-29T03:00:00.000Z",
            latestVolume: 4 + index,
            volumes: [{ volumeNumber: 4 + index, editionIndex: 0 }],
          },
        },
      }));
    case "list_release_inbox": return [];
    case "list_unread_release_changes": return [];
    case "get_collection_update_status": return { provider: args.provider, running: false, checked: 12, changed: 0, failed: 0, cursor: null, lastRunAt: "2026-09-29T03:00:00.000Z", lastError: null };
    case "list_ownership_tracking": return [1, 3, 5];
    case "list_volume_ownership": return [];
    case "list_collection_covers": return Array.from({ length: 10 }, (_, index) => ({ fileName: `volume-${index + 1}.jpg`, shelf: 0, volumeLabel: `${index + 1}권` }));
    case "list_collection_volumes": return Array.from({ length: 12 }, (_, index) => ({ id: `volume-${index + 1}`, volumeNumber: index + 1, editionIndex: 0, displayLabel: `${index + 1}권`, coverArtworkId: `volume-art-${index + 1}`, localReleaseDate: `202${4 + Math.floor(index / 6)}-${String((index % 6) + 1).padStart(2, "0")}-12`, isbn13: `978890${String(index).padStart(7, "0")}`, releaseStatus: index > 9 ? "upcoming" : "released" }));
    case "list_collection_shelf_cases": return (args.collectionIds as string[]).map(collectionId => ({ collectionId, ownedPlatform: null, spineArtworkId: null }));
    case "list_collection_work_artworks": return [{ id: `artwork-${args.collectionId}-cover`, kind: "cover", selected: true }, { id: `artwork-${args.collectionId}-hero`, kind: "hero", selected: true }];
    case "get_igdb_connection": return { collectionId: args.collectionId, gameId: 101, gameName: "Preview Game", updatedAt: "2026-09-28T00:00:00.000Z" };
    case "get_tmdb_connection": return null;
    case "get_mangadex_connection": return null;
    case "get_book_connection": return null;
    case "get_release_watch_status": return { enabled: true, lastCheckedAt: "2026-09-29T03:00:00.000Z" };
    case "take_unread_release_changes": return [];
    case "get_collection_source_root": return "/preview/collections";
    case "get_manga_frequent_index": return { bookmarkCount: 18, tagLimit: 8, artistLimit: 5, tags: ["네토라레", "풀컬러", "안경", "로맨스", "단편", "판타지", "일상", "모험", "코미디"].map((label, index) => ({ kind: "tag", namespace: "female", value: ["netorare", "full color", "glasses", "romance", "short", "fantasy", "everyday", "adventure", "comedy"][index], label, count: 18 - index })), artists: creatorNames.slice(0, 6).map((name, index) => ({ kind: "artist", namespace: "artist", value: name, label: name, count: 8 - index })) };
    case "list_manga_index_pins": return [...mangaPins];
    case "add_manga_index_pin": { const pin = args.identity as MangaIndexIdentity; if (!mangaPins.some(p => p.kind === pin.kind && p.namespace === pin.namespace && p.value === pin.value)) mangaPins.push(pin); return; }
    case "remove_manga_index_pin": { const pin = args.identity as MangaIndexIdentity; mangaPins = mangaPins.filter(p => !(p.kind === pin.kind && p.namespace === pin.namespace && p.value === pin.value)); return; }
    case "get_manga_local_index": return { folders: creatorNames.map((name, index) => ({ name, relativePath: name, seriesCount: index < 8 ? 2 : 1, seriesIds: Array.from({ length: 18 }, (_, i) => i).filter(i => i % creatorNames.length === index).map(i => `manga-${i + 1}`) })), vanished: [...vanishedPreview] };
    case "purge_vanished_manga_folders": { const paths = args.paths as string[]; const removedFolders = vanishedPreview.filter(f => paths.includes(f.relativePath)); vanishedPreview = vanishedPreview.filter(f => !paths.includes(f.relativePath)); return { removedFolders, removedSeriesCount: removedFolders.reduce((sum, f) => sum + f.seriesCount, 0), backupPath: "/preview/library/backups/test.sqlite" }; }
    case "get_manga_root": return "/preview/manga";
    case "get_other_machine_manga_root": return null;
    case "scan_manga": return 0;
    case "list_manga_series": return Array.from({ length: 18 }, (_, index) => ({ id: `manga-${index + 1}`, title: ["해질녘의 기록", "유리별", "작은 정원", "비 오는 오후", "그 여름의 지도", "달빛 우체국"][index % 6] + (index > 5 ? ` ${Math.floor(index / 6) + 1}` : ""), author: creatorNames[index % creatorNames.length]!, galleryId: String(9000 + index), pageCount: 80 + index * 7 }));
    case "get_online_catalog_status": return { installed: true, workCount: 24863, updateEnabled: true, updateIntervalSeconds: 86400, lastAttemptAt: "2026-09-29T03:00:00.000Z", lastSuccessAt: "2026-09-29T03:00:00.000Z", lastAdded: 28, lastError: null, streams: [{ provider: "kHentai", language: "korean", hasState: true, initialComplete: true, watermark: 24863, cursor: 1, pendingMax: 0, lastAttemptAt: "2026-09-29T03:00:00.000Z", lastProgressAt: "2026-09-29T03:00:00.000Z", lastCompletedAt: "2026-09-29T03:00:00.000Z", lastAdded: 28, lastError: null }, { provider: "kHentai", language: "japanese", hasState: true, initialComplete: true, watermark: 12000, cursor: 1, pendingMax: 0, lastAttemptAt: "2026-09-28T03:00:00.000Z", lastProgressAt: "2026-09-28T03:00:00.000Z", lastCompletedAt: "2026-09-28T03:00:00.000Z", lastAdded: 12, lastError: null }] };
    case "run_due_online_catalog_update": return null;
    case "cancel_catalog_search": return null;
    case "search_catalog_groups": {
      const query = (args.query ?? {}) as { page?: number; pageSize?: number };
      const works = catalogWorks();
      const page = query.page ?? 0;
      const size = query.pageSize ?? 48;
      const channel = args.onEvent as { onmessage?: (value: unknown) => void } | undefined;
      channel?.onmessage?.({ type: "page", page: { works: works.slice(page * size, (page + 1) * size), page, pageSize: size } });
      channel?.onmessage?.({ type: "count", totalCount: works.length });
      channel?.onmessage?.({ type: "end", cancelled: false });
      return null;
    }
    case "suggest_online_catalog": return [{ value: "artist:모래빛", label: "작가: 모래빛", count: 18 }, { value: "series:오리지널", label: "시리즈: 오리지널", count: 42 }];
    case "get_online_catalog_work_detail": {
      const work = catalogWorks().find(item => item.providerWorkId === (args.identity as { providerWorkId?: string } | undefined)?.providerWorkId) ?? catalogWorks()[0]!;
      return { ...work, uploader: "preview-uploader", category: 0, updated: work.posted, fileSize: 42_000_000, rating: 4.7, tagGroups: [{ namespace: "artist", values: work.artists }, { namespace: "series", values: work.series }, { namespace: "tag", values: ["full_color", "slice_of_life"] }] };
    }
    case "list_catalog_review": return { rows: [], inspectedWorks: 36, comparisons: 0, skippedBuckets: 0 };
    case "get_catalog_visibility_policy": return { hiddenCategories: [], blockedTags: [] };
    case "get_remote_reading_progress": return null;
    case "notes_request": return notesRequest(args);
    case "get_cloud_capture_settings": return { enabled: true, captureEnabled: true, apiBaseUrl: "https://preview.lakomics.local", tokenConfigured: true };
    case "cloud_publisher_token_status": return { configured: true };
    case "verify_collection_authority_baseline": return { reportPath: "preview/collection-authority/verify-fixture.json", report: {
      version: 1, verdict: "lossless", checkedAt: "2026-10-04T00:00:00Z", validation: null,
      bindings: { legacyRevision: { staged: "fixture", server: "fixture", ok: true } }, counts: {},
      works: { live: 0, staged: 0, matched: 0, missing: [], unknown: [], typeMismatch: [] },
      diffs: { total: 0, byPath: {}, samples: [] }, people: { live: 0, staged: 0, diffs: 0, samples: [] },
      artworks: { originalMissing: 0, unconfirmedBlobs: 0, samples: [] },
    } };
    case "open_collection_authority_report": return null;
    case "set_cloud_publisher_token": return { configured: true };
    case "delete_cloud_publisher_token": return { configured: false };
    case "get_extension_connection": return { baseUrl: "http://127.0.0.1:24821", token: "preview-token", status: "ready" };
    case "test_cloud_capture_connection": return { pendingCount: 3 };
    case "av_link_pending_count": return 0;
    case "get_kakao_credential_status":
    case "get_igdb_credential_status":
    case "get_tmdb_credential_status":
    case "get_stashdb_credential_status": return { configured: true };
    case "cloud_backfill_progress": return { activity: [{ direction: "capture", lastAttemptAt: "2026-09-29T06:00:00.000Z", lastSuccessAt: "2026-09-29T06:00:00.000Z", lastError: null, processed: 3, problems: 0 }], replicationEnabled: true, controlState: "idle", totalAssets: 300, queued: 0, preparing: 0, uploading: 0, committing: 0, completed: 300, failed: 0, activeWorkers: 0, lastError: null };
    case "authority_sync_health": return { albums: { blockedCount: 0, waitingCount: 0, droppedCount: 0, lastDropReason: null, lastDroppedAt: null }, classifications: { blockedCount: 0, waitingCount: 0, droppedCount: 0, lastDropReason: null, lastDroppedAt: null }, assets: { rejectedCount: 0, rejectedReason: null, stopped: false }, characterExclusions: { skippedCount: 0, lastSkipReason: null, lastSkippedAt: null }, authorityPassFailure: null, assetLaneFailure: null };
    case "encrypted_vault_status": return { state: "absent", vaultId: null, root: null, itemCount: null, trashedCount: null, remembered: false };
    case "exchange_snapshot": return { availability: { state: "ready", message: null, needsToken: false }, selfName: "Preview PC", devices: [{ deviceId: "tablet-preview", name: "Galaxy Tab Preview", kind: "tablet" }], outgoing: [], incoming: [], received: [], unseen: 0, folder: "/preview/exchange", tokenConfigured: true };
    case "character_incremental_status": return { running: true, workActive: false, paused: false, automationEnabled: true, broadFolderEnabled: false, completed: 300, confirmed: 84, historyRefreshActive: false, persistentError: null, activeWork: null, historyRefreshes: [] };
    case "list_character_targets": return [];
    case "character_series":
    case "character_folder_exclusions": return [];
    case "character_shadow_review_summary": return { automatic: 0, recommended: 0, targets: [] };
    case "character_shadow_review_page": return { items: [], nextOffset: null, summary: { automatic: { pending: 0 }, recommended: { pending: 0 } } };
    case "character_sidebar_counts": return { targets: {}, groups: {} };
    case "index_missing_similarity_hashes": return { remaining: 0, failed: 0 };
    case "get_image_similarity_scan": return null;
    case "list_similarity_reviews": return { items: [], nextCursor: null, totalCount: 2 };
    case "similarity_review_inbound_status": return { applied: 0 };
    case "list_trash": return { items: [], nextCursor: null, totalCount: 4, totalBytes: 8_400_000 };
    case "get_trash_policy": return { retentionDays: 30 };
    case "prepare_pending_videos": return { processed: 0, remaining: 0, failed: 0, changedAssetIds: [] };
    case "get_internal_playback_url": return `/preview-media/playback/${encodeURIComponent(String(args.assetId ?? "preview"))}`;
    case "get_internal_vault_playback_url": return `/preview-media/vault-playback/${encodeURIComponent(String(args.itemId ?? "preview"))}`;
    case "get_auto_tag_inbox": return { folder: "/preview/inbox", applyTaggerReview: true, last: null };
    case "get_library_statistics": return { assets: 300, collections: 48, favorites: 33, unclassified: 27, originalRecordedBytes: 2_840_000_000, mediaKinds: [{ label: "이미지", count: 283 }, { label: "비디오", count: 17 }], collectedMonths: [{ label: "2026-09", count: 240 }, { label: "2026-08", count: 60 }], creators: previewArtists.slice(0, 5).map(artist => ({ label: artist.label, count: artist.assetCount })), classifications: previewClassifications.slice(1).map(item => ({ label: item.name, count: item.totalAssetCount ?? 0 })), collectionAndDailyStartedAt: "2026-06-01T00:00:00.000Z", mostOpenedAssets: [], mostOpenedCollections: [], longUnseenAssets: [], daily: [] };
    case "measure_library_derivative_storage": return { measuredBytes: 320_000_000, measuredFiles: 620, unavailableFiles: 0, scanLimitReached: false };
    case "list_metadata_backups": return [{ id: "backup-20260929", createdAt: "2026-09-29T02:00:00.000Z", byteSize: 1_240_000 }];
    default: return emptyCommand(command);
  }
}

function notesRequest(args: Record<string, unknown>): unknown {
  const operation = String(args.operation ?? "state");
  if (["state", "sync", "unlock", "unlockKeyring"].includes(operation)) return { unlocked: true, keyringLocked: false, unreadable: 0, notes: previewNotes, lastSyncedAt: "2026-09-29T06:30:00.000Z" };
  if (operation === "secretStatus" || operation === "secretTouch") return { pinSet: true, unlocked: true };
  if (operation === "ledgerMonthId") return { id: "note-ledger-month-2026-09" };
  if (operation === "save") {
    const input = args.input as { id?: string };
    const stored = previewNotes.find(note => note.id === input.id);
    const now = new Date().toISOString();
    return { createdAt: now, ...stored, ...input, updatedAt: now, localRevision: 2, pending: false, conflict: false };
  }
  return null;
}

function emptyCommand(command: string): unknown {
  if (!unknownCommands.has(command)) {
    unknownCommands.add(command);
    console.debug(`[Lakomics preview] no fixture for ${command}`);
  }
  if (command.startsWith("list_") || command.endsWith("_list")) return [];
  if (command.includes("count")) return 0;
  if (command.startsWith("is_") || command.startsWith("has_") || command.endsWith("_enabled")) return false;
  return null;
}
