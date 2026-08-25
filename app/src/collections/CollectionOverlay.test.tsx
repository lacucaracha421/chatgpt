import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LibraryProvider } from "../library/LibraryContext";
import type { CollectionSummary, LibraryGateway, ReleaseWatchEvent } from "../library/types";
import { CollectionOverlay } from "./CollectionOverlay";

afterEach(cleanup);

const collection: CollectionSummary = {
  id: "collection-1",
  name: "던전밥",
  description: null,
  type: "manga",
  coverAssetId: null,
  selectedWorkArtworkId: "artwork-1",
  assetCount: 0,
  unreadReleaseCount: 0,
  year: 2014,
  author: "쿠이 료코",
  developer: null,
  productionCompany: null,
  releaseDate: null,
  director: null,
  externalScore: null,
  myScore: null,
  genres: "판타지",
  overview: null,
  showcase: false,
  showcaseOrder: null,
  createdAt: "t",
  updatedAt: "t",
};

const unread: ReleaseWatchEvent[] = [
  { id: "e1", kind: "new_volume", volumeNumber: 13, previousValue: null, currentValue: "2026-09-01", detectedAt: "2026-08-22T00:00:00Z" },
  { id: "e2", kind: "release_date_changed", volumeNumber: 12, previousValue: "2026-08-21", currentValue: "2026-08-23", detectedAt: "2026-08-22T00:00:00Z" },
  { id: "e3", kind: "release_status_changed", volumeNumber: 11, previousValue: "upcoming", currentValue: "released", detectedAt: "2026-08-22T00:00:00Z" },
];

function renderOverlay(
  overrides: Partial<LibraryGateway> = {},
  onChanged = vi.fn().mockResolvedValue(undefined),
  onExit = vi.fn(),
) {
  const gateway = {
    listCollectionCovers: vi.fn().mockResolvedValue([]),
    listCollectionVolumes: vi.fn().mockResolvedValue([]),
    syncMangaDexVolumeCovers: vi.fn(), inspectLegacyPackageMigration: vi.fn(), executeLegacyPackageMigration: vi.fn().mockResolvedValue({ completed: 0, skipped: 0, failed: 0 }),
    getMangaDexConnection: vi.fn().mockResolvedValue(null),
    refreshMangaDex: vi.fn().mockResolvedValue(collection),
    getAladinCredentialStatus: vi.fn().mockResolvedValue({ configured: false }),
    setAladinTtbKey: vi.fn().mockResolvedValue({ configured: true }),
    deleteAladinTtbKey: vi.fn().mockResolvedValue({ configured: false }),
    searchAladin: vi.fn().mockResolvedValue([]),
    applyAladin: vi.fn().mockResolvedValue({ added: 0, updated: 0, unchanged: 0, ignored: 0 }),
    refreshAladin: vi.fn().mockResolvedValue({ added: 0, updated: 0, unchanged: 0, ignored: 0 }),
    getAladinConnection: vi.fn().mockResolvedValue(null),
    getReleaseWatchStatus: vi.fn().mockResolvedValue({ enabled: false, lastCheckedAt: null }),
    setReleaseWatchEnabled: vi.fn().mockResolvedValue({ enabled: false, lastCheckedAt: null }),
    takeUnreadReleaseChanges: vi.fn().mockResolvedValue([]),
    runDueReleaseWatch: vi.fn().mockResolvedValue({ checked: 0, changedCollections: 0, skipped: 0, stopReason: null }),
    ...overrides,
  } as unknown as LibraryGateway;
  render(
    <LibraryProvider gateway={gateway}>
      <CollectionOverlay collectionId={collection.id} collections={[collection]} onExit={onExit} onChanged={onChanged} />
    </LibraryProvider>,
  );
  return { gateway, onChanged, onExit };
}

async function openProviderMenu(user: ReturnType<typeof userEvent.setup>) {
  await user.click(await screen.findByRole("button", { name: "연결 및 갱신" }));
}

describe("CollectionOverlay MangaDex flow", () => {
  it("presents work information and the volume shelf as named sections", async () => {
    renderOverlay({
      listCollectionVolumes: vi.fn().mockResolvedValue([{
        id: "v1", volumeNumber: 1, editionIndex: 0, displayLabel: "1", coverArtworkId: "art-1",
      }]),
    });

    expect(screen.getByRole("heading", { name: "작품 정보" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "선택한 권" })).toBeInTheDocument();
    expect(await screen.findByRole("heading", { name: "권별 표지" })).toBeInTheDocument();
    expect(screen.getByText("총 1권")).toBeInTheDocument();
    expect(document.querySelector(".collection-overlay__details")).toContainElement(
      screen.getByRole("button", { name: "연결 및 갱신" }),
    );
  });

  it("enables release watch for a connected Aladin manga", async () => {
    const user = userEvent.setup();
    const setReleaseWatchEnabled = vi.fn().mockResolvedValue({ enabled: true, lastCheckedAt: null });
    const { gateway } = renderOverlay({
      getAladinConnection: vi.fn().mockResolvedValue({ anchorItemId: "item-1", query: "던전밥", lastSyncedAt: "t" }),
      getReleaseWatchStatus: vi.fn().mockResolvedValue({ enabled: false, lastCheckedAt: null }),
      setReleaseWatchEnabled,
    });

    expect(screen.queryByRole("button", { name: "신간 알림 켜기" })).not.toBeInTheDocument();
    await openProviderMenu(user);
    await user.click(screen.getByRole("menuitem", { name: "신간 알림 켜기" }));

    expect(setReleaseWatchEnabled).toHaveBeenCalledWith("collection-1", true);
    await openProviderMenu(user);
    expect(await screen.findByRole("menuitem", { name: "신간 알림 끄기" })).toBeInTheDocument();
    expect(gateway.takeUnreadReleaseChanges).toHaveBeenCalledOnce();
  });

  it("disables an enabled release watch", async () => {
    const user = userEvent.setup();
    const setReleaseWatchEnabled = vi.fn().mockResolvedValue({ enabled: false, lastCheckedAt: "t" });
    renderOverlay({
      getAladinConnection: vi.fn().mockResolvedValue({ anchorItemId: "item-1", query: "던전밥", lastSyncedAt: "t" }),
      getReleaseWatchStatus: vi.fn().mockResolvedValue({ enabled: true, lastCheckedAt: "t" }),
      setReleaseWatchEnabled,
    });

    await openProviderMenu(user);
    await user.click(screen.getByRole("menuitem", { name: "신간 알림 끄기" }));

    expect(setReleaseWatchEnabled).toHaveBeenCalledWith("collection-1", false);
    await openProviderMenu(user);
    expect(await screen.findByRole("menuitem", { name: "신간 알림 켜기" })).toBeInTheDocument();
  });

  it("does not expose release watch without an Aladin binding", async () => {
    const user = userEvent.setup();
    const { gateway } = renderOverlay();

    await waitFor(() => expect(gateway.getAladinConnection).toHaveBeenCalledOnce());
    expect(screen.queryByRole("button", { name: /신간 알림/ })).not.toBeInTheDocument();
    await openProviderMenu(user);
    expect(screen.queryByRole("menuitem", { name: /신간 알림/ })).not.toBeInTheDocument();
  });

  it("takes unread changes once, keeps the selected cover, and refreshes the card projection", async () => {
    const onChanged = vi.fn().mockResolvedValue(undefined);
    renderOverlay({
      listCollectionVolumes: vi.fn().mockResolvedValue([{
        id: "v1", volumeNumber: 1, editionIndex: 0, displayLabel: "1", coverArtworkId: "art-1",
      }]),
      takeUnreadReleaseChanges: vi.fn().mockResolvedValue(unread),
    }, onChanged);

    const hero = (await screen.findAllByRole("img", { name: "1권 표지" }))
      .find((image) => image.getAttribute("src")?.includes("work-artwork/art-1"))!;
    const summary = await screen.findByRole("region", { name: "새 출간 정보" });

    expect(summary).toHaveTextContent("새 권: 13권");
    expect(summary).toHaveTextContent("출간일 변경: 12권 2026-08-21 → 2026-08-23");
    expect(summary).toHaveTextContent("출간 상태 변경: 11권 출간 예정 → 출간됨");
    expect(onChanged).toHaveBeenCalledOnce();
    expect(hero).toHaveAttribute("src", "http://lakomics.localhost/work-artwork/art-1");
  });

  it("renders no release summary and does not refresh cards when there are no unread changes", async () => {
    const onChanged = vi.fn().mockResolvedValue(undefined);
    const { gateway } = renderOverlay({}, onChanged);

    await waitFor(() => expect(gateway.takeUnreadReleaseChanges).toHaveBeenCalledOnce());
    expect(screen.queryByRole("region", { name: "새 출간 정보" })).not.toBeInTheDocument();
    expect(onChanged).not.toHaveBeenCalled();
  });

  it("prefers a Volume cover and falls back to stored WorkArtwork", async () => {
    renderOverlay({
      listCollectionVolumes: vi.fn().mockResolvedValue([
        { id: "volume-1", volumeNumber: 1, editionIndex: 0, displayLabel: "1", coverArtworkId: "local-art" },
      ]),
    });
    await waitFor(() => expect(document.querySelector(".collection-overlay__hero img")).toHaveAttribute(
      "src",
      "http://lakomics.localhost/work-artwork/local-art",
    ));
    cleanup();

    renderOverlay();
    expect(await screen.findByRole("img", { name: "던전밥" })).toHaveAttribute(
      "src",
      "http://lakomics.localhost/work-artwork/artwork-1",
    );
  });

  it("shows ordered manga Volume drawers, fills placeholders, and has no fake editor", async () => {
    let finishSync!: (result: { completed: number; skipped: number; failed: number }) => void;
    const syncMangaDexVolumeCovers = vi.fn().mockReturnValue(
      new Promise((resolve) => { finishSync = resolve; }),
    );
    const listCollectionVolumes = vi.fn()
      .mockResolvedValueOnce([
        { id: "v10", volumeNumber: 10, editionIndex: 0, displayLabel: "10", coverArtworkId: null },
        { id: "v2", volumeNumber: 2, editionIndex: 0, displayLabel: "2", coverArtworkId: "art-2" },
        { id: "v1-1", volumeNumber: 1, editionIndex: 1, displayLabel: "1.1", coverArtworkId: "art-1-1" },
      ])
      .mockResolvedValueOnce([
        { id: "v2", volumeNumber: 2, editionIndex: 0, displayLabel: "2", coverArtworkId: "art-2" },
        { id: "v10", volumeNumber: 10, editionIndex: 0, displayLabel: "10", coverArtworkId: "art-10" },
        { id: "v1-1", volumeNumber: 1, editionIndex: 1, displayLabel: "1.1", coverArtworkId: "art-1-1" },
      ]);
    const user = userEvent.setup();
    renderOverlay({ listCollectionVolumes, syncMangaDexVolumeCovers });

    expect(await screen.findAllByRole("button", { name: /^(2|10)권 표지/ })).toHaveLength(2);
    expect(screen.getAllByRole("button", { name: /^(2|10)권 표지/ }).map((button) => button.getAttribute("aria-label"))).toEqual([
      "2권 표지",
      "10권 표지 불러오는 중",
    ]);
    expect(screen.queryByRole("textbox", { name: "권 번호" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "서랍 2" }));
    expect(screen.getByRole("button", { name: "1.1권 표지" })).toBeInTheDocument();

    finishSync({ completed: 1, skipped: 2, failed: 0 });
    await user.click(screen.getByRole("button", { name: "서랍 1" }));
    expect(await screen.findByRole("img", { name: "10권 표지" })).toHaveAttribute(
      "src",
      "http://lakomics.localhost/work-artwork-thumbnail/art-10",
    );
  });

  it("opens artwork covers in the viewer and restores focus without opening placeholders", async () => {
    const user = userEvent.setup();
    const { onExit } = renderOverlay({
      listCollectionVolumes: vi.fn().mockResolvedValue([
        { id: "v1", volumeNumber: 1, editionIndex: 0, displayLabel: "1", coverArtworkId: "art-1" },
        { id: "v2", volumeNumber: 2, editionIndex: 0, displayLabel: "2", coverArtworkId: "art-2" },
        { id: "v3", volumeNumber: 3, editionIndex: 0, displayLabel: "3", coverArtworkId: null },
      ]),
    });

    const opener = await screen.findByRole("button", { name: "2권 표지" });
    await user.click(opener);

    expect(screen.getByRole("dialog", { name: "던전밥 2권 표지 감상" })).toBeInTheDocument();
    expect(screen.getByRole("img", { name: "2권 표지" })).toHaveAttribute(
      "src",
      "http://lakomics.localhost/work-artwork/art-2",
    );
    await user.keyboard("{Escape}");
    await waitFor(() => expect(opener).toHaveFocus());
    expect(onExit).not.toHaveBeenCalled();

    const placeholder = screen.getByRole("button", { name: "3권 표지 불러오는 중" });
    expect(placeholder.querySelector("img")).toBeNull();
    await user.click(placeholder);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("opens the shared import dialog when the manga is not connected", async () => {
    const user = userEvent.setup();
    renderOverlay();

    expect(screen.queryByRole("button", { name: "MangaDex 연결" })).not.toBeInTheDocument();
    await openProviderMenu(user);
    await user.click(screen.getByRole("menuitem", { name: "MangaDex 연결" }));
    expect(screen.getByRole("heading", { name: "MangaDex 연결" })).toBeInTheDocument();
  });

  it("keeps MangaDex separate and opens the text-only Aladin connection dialog", async () => {
    const user = userEvent.setup();
    const { onExit } = renderOverlay({
      getMangaDexConnection: vi.fn().mockResolvedValue({ mangaId: "manga-1", lastSyncedAt: "t" }),
    });

    await openProviderMenu(user);
    expect(screen.getByRole("menuitem", { name: "MangaDex 새로고침" })).toBeInTheDocument();
    await user.click(screen.getByRole("menuitem", { name: "Aladin 연결" }));
    const dialog = screen.getByRole("dialog", { name: "Aladin 연결" });
    expect(dialog).toBeInTheDocument();
    expect(dialog.querySelector("img")).toBeNull();
    await user.keyboard("{Escape}");
    expect(onExit).not.toHaveBeenCalled();
  });

  it("refreshes Aladin releases once and shows Korean publication fields without changing covers", async () => {
    const user = userEvent.setup();
    const initial = {
      id: "v1", volumeNumber: 1, editionIndex: 0, displayLabel: "1", coverArtworkId: "art-1",
      localReleaseDate: null, isbn13: null, releaseStatus: null,
    };
    const released = {
      ...initial,
      localReleaseDate: "2026-08-20", isbn13: "9781234567890", releaseStatus: "released" as const,
    };
    const listCollectionVolumes = vi.fn().mockResolvedValue([initial]);
    const getReleaseWatchStatus = vi.fn().mockResolvedValue({ enabled: true, lastCheckedAt: "t" });
    const { gateway } = renderOverlay({
      listCollectionVolumes,
      getMangaDexConnection: vi.fn().mockResolvedValue({ mangaId: "manga-1", lastSyncedAt: "t" }),
      getAladinConnection: vi.fn().mockResolvedValue({ anchorItemId: "item-1", query: "던전밥", lastSyncedAt: "t" }),
      getReleaseWatchStatus,
      refreshAladin: vi.fn().mockResolvedValue({ added: 0, updated: 1, unchanged: 0, ignored: 0 }),
    });
    const hero = (await screen.findAllByRole("img", { name: "1권 표지" }))
      .find((image) => image.getAttribute("src")?.includes("work-artwork/art-1"))!;
    expect(hero).toHaveAttribute("src", "http://lakomics.localhost/work-artwork/art-1");
    await waitFor(() => expect(gateway.syncMangaDexVolumeCovers).toHaveBeenCalledOnce());
    listCollectionVolumes.mockClear();
    listCollectionVolumes.mockResolvedValue([released]);

    await openProviderMenu(user);
    await user.click(screen.getByRole("menuitem", { name: "Aladin 새로고침" }));

    await waitFor(() => expect(gateway.refreshAladin).toHaveBeenCalledWith("collection-1"));
    expect(getReleaseWatchStatus).toHaveBeenCalledTimes(2);
    expect(listCollectionVolumes).toHaveBeenCalledOnce();
    expect(screen.getByText("2026. 08. 20.")).toBeInTheDocument();
    expect(screen.getByText("9781234567890")).toBeInTheDocument();
    expect(screen.getByText("출간됨")).toBeInTheDocument();
    expect(hero).toHaveAttribute("src", "http://lakomics.localhost/work-artwork/art-1");
    const thumbnail = screen.getAllByRole("img", { name: "1권 표지" })
      .find((image) => image.getAttribute("src")?.includes("work-artwork-thumbnail/art-1"));
    expect(thumbnail).toHaveAttribute("src", "http://lakomics.localhost/work-artwork-thumbnail/art-1");
  });

  it("keeps the shelf visible when Aladin refresh fails", async () => {
    const user = userEvent.setup();
    renderOverlay({
      listCollectionVolumes: vi.fn().mockResolvedValue([{
        id: "v1", volumeNumber: 1, editionIndex: 0, displayLabel: "1", coverArtworkId: "art-1",
        localReleaseDate: null, isbn13: null, releaseStatus: null,
      }]),
      getAladinConnection: vi.fn().mockResolvedValue({ anchorItemId: "item-1", query: "던전밥", lastSyncedAt: "t" }),
      refreshAladin: vi.fn().mockRejectedValue(new Error("알라딘 실패")),
    });

    expect(await screen.findByRole("button", { name: "1권 표지" })).toBeInTheDocument();
    await openProviderMenu(user);
    await user.click(screen.getByRole("menuitem", { name: "Aladin 새로고침" }));
    expect(await screen.findByRole("status")).toHaveTextContent("알라딘 실패");
    expect(screen.getByRole("button", { name: "1권 표지" })).toBeInTheDocument();
  });

  it("refreshes a connected manga and reports the change", async () => {
    const user = userEvent.setup();
    const { gateway, onChanged } = renderOverlay({
      getMangaDexConnection: vi.fn().mockResolvedValue({ mangaId: "manga-1", lastSyncedAt: "t" }),
    });

    await openProviderMenu(user);
    await user.click(screen.getByRole("menuitem", { name: "MangaDex 새로고침" }));
    await waitFor(() => expect(gateway.refreshMangaDex).toHaveBeenCalledWith("collection-1"));
    expect(onChanged).toHaveBeenCalledOnce();
  });

  it("retains the artwork and shows an error when refresh fails", async () => {
    const user = userEvent.setup();
    renderOverlay({
      getMangaDexConnection: vi.fn().mockResolvedValue({ mangaId: "manga-1", lastSyncedAt: "t" }),
      refreshMangaDex: vi.fn().mockRejectedValue(new Error("새로고침하지 못했습니다.")),
    });
    const artwork = await screen.findByRole("img", { name: "던전밥" });

    await openProviderMenu(user);
    await user.click(screen.getByRole("menuitem", { name: "MangaDex 새로고침" }));
    expect(await screen.findByRole("status")).toHaveTextContent("새로고침하지 못했습니다.");
    expect(artwork).toBeInTheDocument();
  });
});
