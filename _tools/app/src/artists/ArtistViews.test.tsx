import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AssetBrowser } from "../assets/AssetBrowser";
import { ChromeSettingsDock, ChromeTarget, WorkspaceChromeProvider } from "../layout/WorkspaceChrome";
import { LibraryProvider } from "../library/LibraryContext";
import type { AssetSummary, AssetView, LibraryGateway } from "../library/types";
import { ArtistHub } from "./ArtistHub";
import { ArtistIndex } from "./ArtistIndex";
import type { ArtistDetail, ArtistGateway, ArtistMergeSuggestion, ArtistOverview, ArtistSummary, SourceFillPreview } from "./types";

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
  pinned: false, hidden: false, main: true, coverAssetIds: ["a1", "a2"], ...overrides,
});

const overview: ArtistOverview = {
  settings: { mainMinCount: 5, recentMinCount: 2, recentDays: 30 },
  total: 4, main: 2, other: 2, twoToFour: 1, single: 1, hidden: 0, unknownNone: 7, unknownSource: 3,
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

const detail: ArtistDetail = {
  summary: artist("artist:moon", "달그림자", { displayName: "달그림자", sourceName: "Moonshade", keys: ["moonshade_art", "48213377"], assetCount: 486, pinned: true }),
  members: [{ key: "moonshade_art", name: "Moonshade", host: "x.com", assetCount: 402 }, { key: "48213377", name: "月影", host: "pixiv", assetCount: 72 }],
  assignments: [{ source: "manual", assetCount: 12, latestAt: "2026-09-20T00:00:00Z" }],
  sources: [{ host: "x.com", count: 402 }, { host: "pixiv", count: 72 }, { host: "manual", count: 12 }],
  onThisDay: { total: 7, assetIds: ["d1", "d2"], yearsAgo: 3, localDate: "2023-09-26" },
  longUnseen: { total: 58, assetIds: ["u1"], yearsAgo: null, localDate: null },
  mergeSuggestions: [],
};

function artistGateway(): ArtistGateway {
  return {
    overview: vi.fn().mockResolvedValue(overview),
    list: vi.fn().mockImplementation(async (query) => ({ total: 2, artists: query.bucket === "main" ? [artist("rin", "Rin Kagura"), artist("sky", "하늘고래")] : [artist("seori", "서리", { main: false, assetCount: 4 })] })),
    detail: vi.fn().mockResolvedValue(detail),
    today: vi.fn().mockResolvedValue([{ artist: artist("yun", "윤슬"), kind: "anniversary", reason: "3년 전 오늘 저장", assetIds: ["t1", "t2"] }]),
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
    listAssets: vi.fn().mockResolvedValue({ items, nextCursor: null, totalCount: items.length }),
    listAssetDateBuckets: vi.fn().mockResolvedValue([]),
    getAsset: vi.fn().mockImplementation(async (id: string) => asset(Number(id.replace(/\D/g, "")) || 0)),
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

describe("ArtistIndex", () => {
  it("lists pins, tiers, 작가 미상 and 정리 with counts; the open pinned artist is the slab", async () => {
    const onNavigate = vi.fn();
    render(<LibraryProvider gateway={libraryGateway(artistGateway())}><ArtistIndex view={{ kind: "creator", creatorKey: "artist:moon" }} onNavigate={onNavigate} /></LibraryProvider>);
    const pinned = await screen.findByRole("button", { name: "달그림자 12장" });
    expect(pinned).toHaveAttribute("aria-current", "page");
    expect(screen.getByRole("button", { name: "주요 작가 2" })).not.toHaveAttribute("aria-current");
    expect(screen.getByRole("button", { name: "작가 미상 7" })).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "같은 작가일 수 있어요 1" }));
    expect(onNavigate).toHaveBeenLastCalledWith({ kind: "artists", section: "merge" });
    await userEvent.click(screen.getByRole("button", { name: "작가 미상 7" }));
    expect(onNavigate).toHaveBeenLastCalledWith({ kind: "creator", creatorKey: "unknown:none" });
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
    expect(await screen.findByRole("article", { name: "윤슬 · 3년 전 오늘 저장" })).toBeInTheDocument();
    const rows = await screen.findByRole("list", { name: "주요 작가" });
    expect(within(rows).getAllByRole("button").map((button) => button.textContent)).toEqual([expect.stringContaining("Rin Kagura"), expect.stringContaining("하늘고래")]);
    await user.click(within(rows).getAllByRole("button")[0]!);
    expect(onNavigate).toHaveBeenCalledWith({ kind: "creator", creatorKey: "rin" });

    await user.click(screen.getByRole("button", { name: /^주요 작가 기준 바꾸기/ }));
    const dialog = await screen.findByRole("dialog", { name: "주요 작가 기준" });
    fireEvent.change(within(dialog).getByLabelText("저장 장수"), { target: { value: "8" } });
    await user.click(within(dialog).getByRole("button", { name: "저장" }));
    expect(gateway.setSettings).toHaveBeenCalledWith({ mainMinCount: 8, recentMinCount: 2, recentDays: 30 });

    await user.click(screen.getByRole("button", { name: "다시 고르기" }));
    await waitFor(() => expect(gateway.today).toHaveBeenLastCalledWith(expect.any(String), expect.any(Number), 1, []));
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
    // The caption uses the artist's own name rather than the source name.
    await waitFor(() => expect(screen.getByRole("option", { name: /asset-0.png/ })).toHaveAttribute("aria-description", expect.stringMatching(/^달그림자 · /)));

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
    fireEvent.click(await screen.findByRole("option", { name: /asset-0.png/ }));
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
});
