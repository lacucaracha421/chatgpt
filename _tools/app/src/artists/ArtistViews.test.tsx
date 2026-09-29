import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AssetBrowser } from "../assets/AssetBrowser";
import { ChromeSettingsDock, ChromeTarget, WorkspaceChromeProvider } from "../layout/WorkspaceChrome";
import { LibraryProvider } from "../library/LibraryContext";
import type { AssetSummary, AssetView, LibraryGateway } from "../library/types";
import { ArtistCollage } from "./ArtistCollage";
import { ArtistHub } from "./ArtistHub";
import { ArtistIndex } from "./ArtistIndex";
import { UnknownStyleSuggestions, useArtistScopeChrome } from "./ArtistPage";
import type { ArtistDetail, ArtistExcludedFolder, ArtistGateway, ArtistMergeSuggestion, ArtistOverview, ArtistStyleGroup, ArtistSummary, SourceFillPreview } from "./types";

afterEach(() => { vi.useRealTimers(); cleanup(); });
beforeEach(() => Object.defineProperties(HTMLElement.prototype, {
  offsetWidth: { configurable: true, get: () => 900 },
  clientWidth: { configurable: true, get: () => 840 },
  offsetHeight: { configurable: true, get: () => 600 },
  clientHeight: { configurable: true, get: () => 600 },
}));

const artist = (id: string, label: string, overrides: Partial<ArtistSummary> = {}): ArtistSummary => ({
  id, label, displayName: null, sourceName: label, keys: [id.replace(/^artist:/, "")], assetCount: 12, recentCount: 0,
  firstSavedAt: "2024-01-01T00:00:00Z", lastSavedAt: "2026-09-12T00:00:00Z", lastOpenedAt: null,
  pinned: false, hidden: false, reposter: false, main: true, coverAssetIds: ["a1", "a2"], ...overrides,
});

const overview: ArtistOverview = {
  settings: { mainMinCount: 5, recentMinCount: 2, recentDays: 30 },
  total: 4, main: 2, other: 2, twoToFour: 1, single: 1, hidden: 0, reposter: 0, styleSuggestionCount: 0, unknownNone: 7, unknownSource: 3,
  mergeSuggestions: 1, sourceFillable: 2, pinned: [artist("artist:moon", "달그림자", { pinned: true })],
};

const suggestion: ArtistMergeSuggestion = {
  keyA: "Kiri_Draws", keyB: "kiri_draws", kind: "handle", uncertain: false,
  left: artist("kiri_draws", "Kiri", { assetCount: 41 }), right: artist("Kiri_Draws", "키리 커미션OPEN", { assetCount: 14 }),
};

const fill: SourceFillPreview = {
  total: 5, fillable: 2, withoutHandle: 1, existingArtists: 1, newArtists: 1,
  sites: [{ host: "x.com", assetCount: 3, method: "auto", fillable: 2 }, { host: "arca.live", assetCount: 2, method: "manual", fillable: 0 }],
  groups: [{ handle: "kiri_draws", assetCount: 1, sampleAssetIds: ["s1"], targetId: "kiri_draws", targetLabel: "Kiri" }, { handle: "glass_owl", assetCount: 1, sampleAssetIds: ["s2"], targetId: null, targetLabel: null }],
};

const styleGroup: ArtistStyleGroup = {
  artist: artist("artist:tunoboku", "tunoboku", { assetCount: 38, coverAssetIds: ["ref-avatar"] }),
  candidates: [{ assetId: "candidate-1", score: 0.71 }, { assetId: "candidate-2", score: 0.63 }],
  referenceAssetIds: ["ref-1", "ref-2", "ref-3", "ref-4"],
};

const detail: ArtistDetail = {
  summary: artist("artist:moon", "달그림자", { displayName: "달그림자", sourceName: "Moonshade", keys: ["moonshade_art", "48213377"], assetCount: 486, pinned: true }),
  members: [{ key: "moonshade_art", name: "Moonshade", host: "x.com", assetCount: 402 }, { key: "48213377", name: "月影", host: "pixiv", assetCount: 72 }],
  assignments: [{ source: "manual", assetCount: 12, latestAt: "2026-09-20T00:00:00Z" }],
  sources: [{ host: "x.com", count: 402 }, { host: "pixiv", count: 72 }, { host: "manual", count: 12 }],
  onThisDay: { total: 7, assetIds: ["d1", "d2"], yearsAgo: 3, localDate: "2023-09-26" },
  longUnseen: { total: 58, assetIds: ["u1"], yearsAgo: null, localDate: null },
  mergeSuggestions: [],
};

function artistGateway(initialExcluded: ArtistExcludedFolder[] = []): ArtistGateway {
  let excluded = initialExcluded;
  return {
    overview: vi.fn().mockResolvedValue(overview),
    styleSuggestions: vi.fn().mockResolvedValue({ totalImages: 0, totalArtists: 0, groups: [] }),
    styleSuggestion: vi.fn().mockResolvedValue(null),
    dismissStyleSuggestion: vi.fn().mockResolvedValue(undefined),
    importStyleFeatures: vi.fn().mockResolvedValue({ imported: 0, skipped: 0 }),
    styleStatus: vi.fn().mockResolvedValue({ features: 0, model: null, suggestions: 0, computing: false }),
    list: vi.fn().mockImplementation(async (query) => ({ total: 2, artists: query.bucket === "main" ? [artist("rin", "Rin Kagura"), artist("sky", "하늘고래", { recentCount: 3 })] : [artist("seori", "서리", { main: false, assetCount: 4 })] })),
    detail: vi.fn().mockResolvedValue(detail),
    today: vi.fn().mockResolvedValue([{ artist: artist("yun", "윤슬"), kind: "anniversary", reason: "3년 전 오늘 저장", assetIds: ["t1", "t2", "t3", "t4", "t5", "t6"] }]),
    mergeSuggestions: vi.fn().mockResolvedValue([suggestion]),
    sourceFillPreview: vi.fn().mockResolvedValue(fill),
    applySourceFill: vi.fn().mockResolvedValue({ assigned: 2, createdArtists: 1 }),
    captionLabels: vi.fn().mockResolvedValue({ byKey: { moonshade_art: "달그림자" }, byAsset: {} }),
    setDisplayName: vi.fn().mockResolvedValue("artist:moon"),
    setFlags: vi.fn().mockResolvedValue("artist:moon"),
    merge: vi.fn().mockResolvedValue("artist:kiri"),
    detachMember: vi.fn().mockResolvedValue("artist:moon"),
    detachAssignments: vi.fn().mockResolvedValue("artist:moon"),
    dismissSuggestion: vi.fn().mockResolvedValue(undefined),
    assignAssets: vi.fn().mockResolvedValue("artist:new"),
    setSettings: vi.fn().mockImplementation(async (settings) => settings),
    listExcludedFolders: vi.fn().mockImplementation(async () => excluded),
    setExcludedFolders: vi.fn().mockImplementation(async (ids: string[]) => {
      excluded = ids.map((id) => ({ id, breadcrumb: id === "ai" ? "기타 › ai" : id, imageCount: 3 }));
    }),
  };
}

const asset = (index: number, creator: Partial<AssetSummary> = {}): AssetSummary => ({
  id: `asset-${index}`, title: null, originalName: `asset-${index}.png`, byteSize: 1, width: 200, height: 200,
  collectedAt: "2026-07-30T00:00:00Z", favorite: false, sourceUrl: null, sourcePublishedAt: null,
  creatorName: null, creatorHandle: null, creatorUrl: null, importSource: null, importBatchId: null, originalModifiedAt: null,
  media: { kind: "image" }, ...creator,
});

/** A gateway whose unlisted methods resolve to empty results. */
function libraryGateway(artists: ArtistGateway, items: AssetSummary[] = []): LibraryGateway {
  const known: Record<string, unknown> = {
    artists,
    // No auto-tag service in these views; a proxy function here would look like a broken gateway.
    autoTags: undefined,
    listAssets: vi.fn().mockResolvedValue({ items, nextCursor: null, totalCount: items.length }),
    listAssetDateBuckets: vi.fn().mockResolvedValue([]),
    getAsset: vi.fn().mockImplementation(async (id: string) => asset(Number(id.replace(/\D/g, "")) || 0)),
    listClassifications: vi.fn().mockResolvedValue([
      { id: "other", kind: "root", name: "기타", parentId: null, iconKey: null, colorKey: null, totalAssetCount: 4 },
      { id: "ai", kind: "tag", name: "ai", parentId: "other", iconKey: null, colorKey: null, totalAssetCount: 3 },
    ]),
  };
  return new Proxy(known, { get: (target, key: string) => (key in target ? target[key] : (target[key] = vi.fn().mockResolvedValue([]))) }) as unknown as LibraryGateway;
}

function chrome(child: ReactNode) {
  return <WorkspaceChromeProvider scope="artist-test">
    <aside aria-label="인덱스"><ChromeTarget name="navigation" /><ChromeSettingsDock /></aside>
    <div data-testid="titlebar"><ChromeTarget name="header" /></div>
    {child}
  </WorkspaceChromeProvider>;
}

function ArtistScopeIntro({ view, onNavigate }: { view: AssetView; onNavigate: (view: AssetView) => void }) {
  return <>{useArtistScopeChrome(view, { onNavigate, onPlay: vi.fn(), privacyMode: false })?.intro}</>;
}

describe("ArtistIndex", () => {
  it("lists pins, tiers, 작가 미상 and 정리 with counts; the open pinned artist is the slab", async () => {
    const onNavigate = vi.fn();
    render(<LibraryProvider gateway={libraryGateway(artistGateway())}><ArtistIndex view={{ kind: "creator", creatorKey: "artist:moon" }} onNavigate={onNavigate} /></LibraryProvider>);
    const pinned = await screen.findByRole("button", { name: "달그림자 12장" });
    expect(pinned).toHaveAttribute("aria-current", "page");
    expect(screen.getByRole("button", { name: "Rin Kagura 12장" })).not.toHaveAttribute("aria-current");
    expect(screen.getByRole("button", { name: "작가 미상 7" })).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "같은 작가일 수 있어요 1" }));
    expect(onNavigate).toHaveBeenLastCalledWith({ kind: "artists", section: "merge" });
    await userEvent.click(screen.getByRole("button", { name: "작가 미상 7" }));
    expect(onNavigate).toHaveBeenLastCalledWith({ kind: "creator", creatorKey: "unknown:none" });
  });

  it("shows the style recommendation badge and removes the old cleanup groups", async () => {
    const gateway = artistGateway();
    gateway.overview = vi.fn().mockResolvedValue({ ...overview, styleSuggestionCount: 4, reposter: 3 });
    const onNavigate = vi.fn();
    render(<LibraryProvider gateway={libraryGateway(gateway)}><ArtistIndex view={{ kind: "artists", section: "reposter" }} onNavigate={onNavigate} /></LibraryProvider>);

    expect(await screen.findByLabelText("추천 4")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /퍼온 계정/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /그 외 작가/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /한 장뿐인 작가들/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /숨긴 작가/ })).not.toBeInTheDocument();
  });

  it("searches non-main artists by name and 초성", async () => {
    const user = userEvent.setup();
    const gateway = artistGateway();
    gateway.list = vi.fn().mockImplementation(async (query) => query.bucket === "main"
      ? { total: 1, artists: [artist("rin", "Rin Kagura")] }
      : { total: 2, artists: [artist("rin", "Rin Kagura"), artist("seori", "서리", { main: false, hidden: true, assetCount: 4 })] });
    const onNavigate = vi.fn();
    render(<LibraryProvider gateway={libraryGateway(gateway)}><ArtistIndex view={{ kind: "artists" }} onNavigate={onNavigate} /></LibraryProvider>);

    const search = screen.getByRole("searchbox", { name: "주요 작가 찾기" });
    await user.type(search, "ㅅㄹ");
    const result = await screen.findByRole("button", { name: "서리 4장" });
    expect(result).toBeInTheDocument();
    await user.click(result);
    expect(onNavigate).toHaveBeenLastCalledWith({ kind: "creator", creatorKey: "seori" });
  });
});

describe("style recommendation rows", () => {
  const renderSuggestions = (gateway = artistGateway()) => {
    const onNavigate = vi.fn();
    gateway.styleSuggestions = vi.fn().mockResolvedValue({ totalImages: 2, totalArtists: 1, groups: [styleGroup] });
    render(<LibraryProvider gateway={libraryGateway(gateway)}><UnknownStyleSuggestions privacyMode={false} onNavigate={onNavigate} /></LibraryProvider>);
    return gateway;
  };

  it("assigns only checked candidate images", async () => {
    const user = userEvent.setup();
    const gateway = renderSuggestions();
    await screen.findByRole("article", { name: "tunoboku 닮은 작가 추천" });
    await user.click(screen.getByRole("checkbox", { name: "tunoboku 0.71 이미지 지정" }));
    await user.click(screen.getByRole("button", { name: "선택한 이미지 지정 1" }));
    expect(gateway.assignAssets).toHaveBeenCalledWith(["candidate-2"], { artistId: "artist:tunoboku" });
  });

  it("dismisses the checked candidate images for an artist", async () => {
    const user = userEvent.setup();
    const gateway = renderSuggestions();
    await screen.findByRole("article", { name: "tunoboku 닮은 작가 추천" });
    await user.click(screen.getByRole("checkbox", { name: "tunoboku 0.63 이미지 지정" }));
    await user.click(screen.getByRole("button", { name: "이 작가 아님" }));
    expect(gateway.dismissStyleSuggestion).toHaveBeenCalledWith(["candidate-1"], "artist:tunoboku");
  });

  it("confirms before marking an artist as a reposter", async () => {
    const user = userEvent.setup();
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    const gateway = renderSuggestions();
    await screen.findByRole("article", { name: "tunoboku 닮은 작가 추천" });
    await user.click(screen.getByRole("button", { name: "퍼온 계정으로 표시" }));
    expect(confirm).toHaveBeenCalledWith(expect.stringContaining("모든 추천 대상"));
    expect(gateway.setFlags).toHaveBeenCalledWith("artist:tunoboku", { reposter: true });
    confirm.mockRestore();
  });

  it("navigates the third unknown-artist chip to the suggested-only view", async () => {
    const user = userEvent.setup();
    const gateway = artistGateway();
    gateway.overview = vi.fn().mockResolvedValue({ ...overview, styleSuggestionCount: 2 });
    const onNavigate = vi.fn();
    render(<LibraryProvider gateway={libraryGateway(gateway)}><ArtistScopeIntro view={{ kind: "creator", creatorKey: "unknown:none" }} onNavigate={onNavigate} /></LibraryProvider>);
    await user.click(await screen.findByRole("button", { name: "추천 있음 2" }));
    expect(onNavigate).toHaveBeenCalledWith({ kind: "creator", creatorKey: "unknown:none", styleSuggestionsOnly: true });
  });
});

describe("ArtistHub", () => {
  const renderHub = (view: Extract<AssetView, { kind: "artists" }>, gateway = artistGateway()) => {
    const onNavigate = vi.fn();
    render(<LibraryProvider gateway={libraryGateway(gateway)}>{chrome(<ArtistHub view={view} onNavigate={onNavigate} privacyMode={false} />)}</LibraryProvider>);
    return { gateway, onNavigate };
  };

  it("shows 오늘 and the main artists, and edits the tier rule from the header", async () => {
    const user = userEvent.setup();
    const { gateway, onNavigate } = renderHub({ kind: "artists" });
    const hero = await screen.findByRole("article", { name: "윤슬 · 3년 전 오늘 저장" });
    expect(hero).toBeInTheDocument();
    expect(within(hero).getByText("+7")).toBeInTheDocument();
    const grid = await screen.findByRole("list", { name: "주요 작가" });
    expect(within(grid).getByRole("button", { name: /^Rin Kagura 12장/ })).toBeInTheDocument();
    expect(within(grid).getByRole("button", { name: /^하늘고래 12장/ })).toBeInTheDocument();
    expect(within(grid).getByText("최근 저장 9.12")).toBeInTheDocument();
    expect(within(grid).getByText("최근 30일 3장 · 저장 9.12")).toBeInTheDocument();
    await user.click(within(grid).getByRole("button", { name: /^Rin Kagura 12장/ }));
    expect(onNavigate).toHaveBeenCalledWith({ kind: "creator", creatorKey: "rin" });

    await user.click(screen.getByRole("button", { name: /^주요 작가 기준 바꾸기/ }));
    const dialog = await screen.findByRole("dialog", { name: "주요 작가 기준" });
    fireEvent.change(within(dialog).getByLabelText("저장 장수"), { target: { value: "8" } });
    await user.click(within(dialog).getByRole("button", { name: "저장" }));
    expect(gateway.setSettings).toHaveBeenCalledWith({ mainMinCount: 8, recentMinCount: 2, recentDays: 30 });

    await user.click(screen.getByRole("button", { name: "다시 고르기" }));
    await waitFor(() => expect(gateway.today).toHaveBeenLastCalledWith(expect.any(String), expect.any(Number), 1, []));
  });

  it("adds and removes an artist excluded folder from the rule settings", async () => {
    const user = userEvent.setup();
    const { gateway } = renderHub({ kind: "artists" });
    await screen.findByRole("list", { name: "주요 작가" });
    await user.click(screen.getByRole("button", { name: /^주요 작가 기준 바꾸기/ }));
    const dialog = await screen.findByRole("dialog", { name: "주요 작가 기준" });
    await user.click(within(dialog).getByRole("button", { name: "폴더 추가" }));
    await user.click(within(dialog).getByRole("option", { name: /기타 › ai/ }));
    await waitFor(() => expect(gateway.setExcludedFolders).toHaveBeenLastCalledWith(["ai"]));
    expect(within(dialog).getByText("기타 › ai")).toBeInTheDocument();
    await user.click(within(dialog).getByRole("button", { name: "기타 › ai 제외 해제" }));
    await waitFor(() => expect(gateway.setExcludedFolders).toHaveBeenLastCalledWith([]));
  });

  it("swaps the hero to another today artist without refetching today", async () => {
    const user = userEvent.setup();
    const gateway = artistGateway();
    gateway.today = vi.fn().mockResolvedValue([
      { artist: artist("yun", "윤슬"), kind: "anniversary", reason: "3년 전 오늘 저장", assetIds: ["t1", "t2", "t3"] },
      { artist: artist("mira", "미라", { assetCount: 3 }), kind: "fresh", reason: "이번 주 새로 저장", assetIds: ["m1", "m2"] },
    ]);
    renderHub({ kind: "artists" }, gateway);
    await screen.findByRole("article", { name: "윤슬 · 3년 전 오늘 저장" });
    await user.click(screen.getByRole("button", { name: "미라 · 이번 주 새로 저장" }));
    expect(await screen.findByRole("article", { name: "미라 · 이번 주 새로 저장" })).toBeInTheDocument();
    expect(gateway.today).toHaveBeenCalledTimes(1);
  });

  it("다시 고르기 shows another hero even when the server returns the same picks", async () => {
    const user = userEvent.setup();
    const gateway = artistGateway();
    gateway.today = vi.fn().mockResolvedValue([
      { artist: artist("yun", "윤슬"), kind: "anniversary", reason: "3년 전 오늘 저장", assetIds: ["t1", "t2", "t3"] },
      { artist: artist("mira", "미라", { assetCount: 3 }), kind: "fresh", reason: "이번 주 새로 저장", assetIds: ["m1", "m2"] },
    ]);
    renderHub({ kind: "artists" }, gateway);
    await screen.findByRole("article", { name: "윤슬 · 3년 전 오늘 저장" });
    await user.click(screen.getByRole("button", { name: "다시 고르기" }));
    expect(await screen.findByRole("article", { name: "미라 · 이번 주 새로 저장" })).toBeInTheDocument();
  });

  it("keeps the card pin action and existing menu items", async () => {
    const user = userEvent.setup();
    const { gateway } = renderHub({ kind: "artists" });
    const grid = await screen.findByRole("list", { name: "주요 작가" });
    within(grid).getByRole("button", { name: "Rin Kagura 더보기" }).focus();
    await user.keyboard("{ArrowDown}");
    expect(await screen.findByRole("menuitem", { name: "이름 바꾸기" })).toBeInTheDocument();
    await user.keyboard("{Escape}");
    await user.click(within(grid).getByRole("button", { name: "Rin Kagura 고정" }));
    expect(gateway.setFlags).toHaveBeenCalledWith("rin", { pinned: true });
  });

  it("searches 그 외 작가 by 초성 and narrows with the count filters", async () => {
    const user = userEvent.setup();
    const { gateway } = renderHub({ kind: "artists", section: "others" });
    await screen.findByRole("list", { name: "작가 목록" });
    await user.type(screen.getByRole("searchbox", { name: "작가 찾기" }), "ㅅㄹ");
    await waitFor(() => expect(gateway.list).toHaveBeenLastCalledWith(expect.objectContaining({ bucket: "all", search: "ㅅㄹ" })));
    expect(await screen.findByText(/초성 ㅅㄹ/)).toBeInTheDocument();
    await user.clear(screen.getByRole("searchbox", { name: "작가 찾기" }));
    await user.click(screen.getByRole("button", { name: /^1장/ }));
    await waitFor(() => expect(gateway.list).toHaveBeenLastCalledWith(expect.objectContaining({ bucket: "single", search: null })));
  });

  it("merges a suggestion under the chosen name or keeps the pair apart", async () => {
    const user = userEvent.setup();
    const { gateway } = renderHub({ kind: "artists", section: "merge" });
    const card = await screen.findByRole("article", { name: "Kiri와 키리 커미션OPEN" });
    await user.click(within(card).getByRole("radio", { name: "키리 커미션OPEN" }));
    await user.click(within(card).getByRole("button", { name: "합치기" }));
    expect(gateway.merge).toHaveBeenCalledWith("kiri_draws", ["Kiri_Draws"], "키리 커미션OPEN");
    await user.click(within(card).getByRole("button", { name: "따로 두기" }));
    expect(gateway.dismissSuggestion).toHaveBeenCalledWith("Kiri_Draws", "kiri_draws");
  });

  it("previews x.com handles and fills them in one step; forum sources stay manual", async () => {
    const user = userEvent.setup();
    const { gateway, onNavigate } = renderHub({ kind: "artists", section: "source-fill" });
    await user.click(await screen.findByRole("button", { name: "미리보기" }));
    const preview = screen.getByRole("complementary", { name: "x.com 채우기 미리보기" });
    expect(within(preview).getByText("@glass_owl")).toBeInTheDocument();
    expect(within(preview).getByText("새 작가")).toBeInTheDocument();
    await user.click(within(preview).getByRole("button", { name: "2장 채우기" }));
    expect(gateway.applySourceFill).toHaveBeenCalledTimes(1);
    expect(await screen.findByText("2장을 작가와 이었어요 · 새 작가 1명")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "작가 미상에서 보기" }));
    expect(onNavigate).toHaveBeenCalledWith({ kind: "creator", creatorKey: "unknown:source" });
  });
});

describe("ArtistCollage", () => {
  it("uses the 1, 2, and 3 image split rules and keeps privacy cells empty", () => {
    const { container } = render(<>
      <ArtistCollage assetIds={["a1"]} privacyMode={false} />
      <ArtistCollage assetIds={["a1", "a2"]} privacyMode={false} />
      <ArtistCollage assetIds={["a1", "a2", "a3", "a4"]} privacyMode={true} />
    </>);
    const collages = container.querySelectorAll(".artist-collage");
    expect(collages[0]).toHaveClass("artist-collage--n1");
    expect(collages[0]?.querySelectorAll(".artist-collage__cell")).toHaveLength(1);
    expect(collages[1]).toHaveClass("artist-collage--n2");
    expect(collages[1]?.querySelectorAll(".artist-collage__cell")).toHaveLength(2);
    expect(collages[2]).toHaveClass("artist-collage--n3");
    expect(collages[2]?.querySelectorAll(".artist-collage__cell")).toHaveLength(3);
    expect(collages[2]?.querySelectorAll("img")).toHaveLength(0);
  });
});

describe("artist pages in the gallery", () => {
  const renderPage = (view: AssetView, gateway: LibraryGateway) => {
    const onViewChange = vi.fn();
    render(<LibraryProvider gateway={gateway}>{chrome(<AssetBrowser galleryLayout="justified" view={view} onViewChange={onViewChange} classifications={[]} sort="newest"
      metadataVisible privacyMode={false} onPrivacyModeChange={vi.fn()} refreshVersion={0} onSortChange={vi.fn()} onMetadataVisibleChange={vi.fn()} onStatusChange={vi.fn()} />)}</LibraryProvider>);
    return onViewChange;
  };

  it("scopes the gallery to the artist, shows its summary and 다시보기, and saves 작가 편집", async () => {
    const user = userEvent.setup();
    const artists = artistGateway();
    const gateway = libraryGateway(artists, [asset(0, { creatorHandle: "moonshade_art", creatorName: "Moonshade" })]);
    renderPage({ kind: "creator", creatorKey: "artist:moon" }, gateway);
    await waitFor(() => expect(gateway.listAssets).toHaveBeenCalledWith(expect.objectContaining({ creatorKey: "artist:moon" })));
    expect(await screen.findByRole("heading", { name: "달그림자" })).toBeInTheDocument();
    expect(await screen.findByText("3년 전 오늘")).toBeInTheDocument();
    expect(screen.getByText("1년 넘게 열지 않은 58장")).toBeInTheDocument();
    expect(screen.getByText("x 402 · Pixiv 72 · 지정 12")).toBeInTheDocument();
    // Tiles carry no artist caption, not even the artist's own name (user, 2026-09-29).
    expect(within(await screen.findByRole("option", { name: /asset-0.png/ })).queryByText("달그림자")).toBeNull();

    await user.click(screen.getByRole("button", { name: "작가 편집" }));
    const panel = screen.getByRole("complementary", { name: "작가 편집" });
    await user.clear(within(panel).getByLabelText("표시 이름"));
    await user.type(within(panel).getByLabelText("표시 이름"), "달");
    await user.click(within(panel).getAllByRole("button", { name: "떼어내기" })[1]!);
    expect(artists.detachMember).toHaveBeenCalledWith("artist:moon", "48213377");
    await user.click(within(panel).getByRole("button", { name: "저장" }));
    expect(artists.setDisplayName).toHaveBeenCalledWith("artist:moon", "달");
    expect(artists.setFlags).not.toHaveBeenCalled();
  });

  it("assigns selected 작가 미상 images to a new artist without touching their creator fields", async () => {
    const user = userEvent.setup();
    const artists = artistGateway();
    const gateway = libraryGateway(artists, [asset(0), asset(1)]);
    renderPage({ kind: "creator", creatorKey: "unknown:none" }, gateway);
    expect(await screen.findByRole("button", { name: "출처 없음 7" })).toHaveAttribute("aria-pressed", "true");
    // A plain click opens 정보; Ctrl-click selects.
    fireEvent.click(await screen.findByRole("option", { name: /asset-0.png/ }), { ctrlKey: true });
    fireEvent.click(screen.getByRole("option", { name: /asset-1.png/ }), { ctrlKey: true });
    await user.click(screen.getByRole("button", { name: "작가 지정" }));
    const dialog = await screen.findByRole("dialog", { name: "작가 지정 · 2장" });
    await user.type(within(dialog).getByRole("searchbox", { name: "작가 찾기" }), "하늘빛");
    await user.click(await within(dialog).findByRole("button", { name: /'하늘빛' 이름으로 새 작가 만들기/ }));
    await act(async () => { await user.click(within(dialog).getByRole("button", { name: "하늘빛에 붙이기" })); });
    expect(artists.assignAssets).toHaveBeenCalledWith(["asset-0", "asset-1"], { newName: "하늘빛" });
    expect(await screen.findByText("2장을 하늘빛에 붙였어요")).toBeInTheDocument();
    expect(gateway.updateAssetMetadata).not.toHaveBeenCalled();
  });

  it("saves the reposter flag from the artist edit panel", async () => {
    const user = userEvent.setup();
    const artists = artistGateway();
    renderPage({ kind: "creator", creatorKey: "artist:moon" }, libraryGateway(artists, [asset(0)]));
    await user.click(await screen.findByRole("button", { name: "작가 편집" }));
    const panel = screen.getByRole("complementary", { name: "작가 편집" });
    await user.click(within(panel).getByRole("checkbox", { name: "퍼온 계정 — 작가가 아님" }));
    await user.click(within(panel).getByRole("button", { name: "저장" }));
    expect(artists.setFlags).toHaveBeenCalledWith("artist:moon", { reposter: true });
  });
});
