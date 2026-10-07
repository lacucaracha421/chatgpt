import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { LibraryProvider } from "../library/LibraryContext";
import type { CollectionTrashPage, LibraryGateway, TrashPage } from "../library/types";
import { PrivacyProvider } from "../privacy/PrivacyContext";
import { TrashBrowser } from "./TrashBrowser";
import { ASSET_LIFECYCLE_CHANGED_EVENT } from "../app/useAssetAuthoritySync";
import { WorkspaceChromeProvider, ChromeTarget } from "../layout/WorkspaceChrome";
import { NotesTrashSection } from "./TrashBrowser";
import { NotesStore, type NotesRequest, type Note } from "../notes/store";
import { TRASH_SECTION_STORAGE_KEY } from "./trashSections";

function renderTrash(ui: React.ReactElement, gateway?: LibraryGateway) {
  return render(
    <LibraryProvider gateway={gateway ?? createGateway()}>
      <WorkspaceChromeProvider scope="trash-test">
        <aside aria-label="index"><ChromeTarget name="actions" /><ChromeTarget name="navigation" /><ChromeTarget name="search" /><ChromeTarget name="settings" /><ChromeTarget name="header" /></aside>
        {ui}
      </WorkspaceChromeProvider>
    </LibraryProvider>,
  );
}

afterEach(() => { cleanup(); localStorage.removeItem(TRASH_SECTION_STORAGE_KEY); });

it("loads trash, shows its purge date, and restores an asset", async () => {
  const user = userEvent.setup();
  const gateway = createGateway();

  renderTrash(<TrashBrowser />, gateway);
  await userEvent.click(screen.getByText("보존 설정", { exact: false, selector: "summary" }));

  await waitFor(() => expect(gateway.listTrash).toHaveBeenCalledWith({ after: null, limit: 100 }));
  expect(await screen.findByText("영구 삭제까지 12일")).toBeVisible();
  await user.click(screen.getByRole("button", { name: "복원" }));
  expect(gateway.restoreAsset).toHaveBeenCalledWith("asset-1");
});

it("reports the trash total count after each load", async () => {
  const onCountChange = vi.fn();
  const gateway = createGateway();
  vi.mocked(gateway.listTrash).mockResolvedValue({ items: [], nextCursor: null, totalCount: 7, totalBytes: 0 });

  renderTrash(<TrashBrowser onCountChange={onCountChange} />, gateway);

  await waitFor(() => expect(onCountChange).toHaveBeenLastCalledWith(7));
});

it("reloads when another device trashes or restores an asset", async () => {
  const onCountChange = vi.fn();
  const gateway = createGateway();
  vi.mocked(gateway.listTrash).mockResolvedValue({ items: [], nextCursor: null, totalCount: 1, totalBytes: 0 });

  renderTrash(<TrashBrowser onCountChange={onCountChange} />, gateway);
  await waitFor(() => expect(onCountChange).toHaveBeenLastCalledWith(1));
  vi.mocked(gateway.listTrash).mockResolvedValue({ items: [], nextCursor: null, totalCount: 2, totalBytes: 0 });
  act(() => { window.dispatchEvent(new Event(ASSET_LIFECYCLE_CHANGED_EVENT)); });

  await waitFor(() => expect(onCountChange).toHaveBeenLastCalledWith(2));
});

it("keeps retention controls disabled until the policy is loaded", async () => {
  const gateway = createGateway();
  vi.mocked(gateway.getTrashPolicy).mockReturnValue(new Promise(() => undefined));

  renderTrash(<TrashBrowser />, gateway);
  await userEvent.click(screen.getByText("보존 설정", { exact: false, selector: "summary" }));

  expect(screen.getByRole("checkbox", { name: "자동 삭제" })).toBeDisabled();
  expect(screen.getByRole("checkbox", { name: "자동 삭제" })).not.toBeChecked();
  expect(screen.queryByRole("spinbutton", { name: "보존 기간" })).not.toBeInTheDocument();
});

it("keeps a loaded trash page visible when the policy request fails and retries both", async () => {
  const user = userEvent.setup();
  const gateway = createGateway();
  vi.mocked(gateway.getTrashPolicy)
    .mockRejectedValueOnce(new Error("policy failed"))
    .mockResolvedValueOnce({ retentionDays: 30 });

  renderTrash(<TrashBrowser />, gateway);
  await userEvent.click(screen.getByText("보존 설정", { exact: false, selector: "summary" }));

  expect(await screen.findByText("asset-1.png")).toBeVisible();
  expect(screen.getByRole("checkbox", { name: "자동 삭제" })).toBeDisabled();
  expect(screen.getByText("policy failed")).toBeVisible();
  await user.click(screen.getByRole("button", { name: "다시 시도" }));

  await waitFor(() => expect(gateway.listTrash).toHaveBeenCalledTimes(2));
  await waitFor(() => expect(gateway.getTrashPolicy).toHaveBeenCalledTimes(2));
  expect(screen.getByRole("checkbox", { name: "자동 삭제" })).not.toBeDisabled();
});

it("shows a retry instead of an empty state when listing trash fails", async () => {
  const user = userEvent.setup();
  const gateway = createGateway();
  vi.mocked(gateway.listTrash)
    .mockRejectedValueOnce(new Error("trash list failed"))
    .mockResolvedValueOnce({ items: [{ asset: asset(), trashedAt: "2026-07-20T00:00:00Z", purgeAt: null }], nextCursor: null, totalCount: 1, totalBytes: 1_024 });

  renderTrash(<TrashBrowser />, gateway);
  await userEvent.click(screen.getByText("보존 설정", { exact: false, selector: "summary" }));

  expect(await screen.findByText("trash list failed")).toBeVisible();
  expect(screen.queryByText("휴지통이 비어 있습니다")).not.toBeVisible();
  await user.click(screen.getByRole("button", { name: "다시 시도" }));

  expect(await screen.findByText("asset-1.png")).toBeVisible();
});

it("retries after listing trash fails while policy loading is still pending", async () => {
  const neverPolicy = new Promise<{ retentionDays: number | null }>(() => undefined);
  const user = userEvent.setup();
  const gateway = createGateway();
  vi.mocked(gateway.listTrash)
    .mockRejectedValueOnce(new Error("trash list failed"))
    .mockResolvedValueOnce({ items: [{ asset: asset(), trashedAt: "2026-07-20T00:00:00Z", purgeAt: null }], nextCursor: null, totalCount: 1, totalBytes: 1_024 });
  vi.mocked(gateway.getTrashPolicy)
    .mockReturnValueOnce(neverPolicy)
    .mockResolvedValueOnce({ retentionDays: 30 });

  renderTrash(<TrashBrowser />, gateway);
  await userEvent.click(screen.getByText("보존 설정", { exact: false, selector: "summary" }));

  expect(await screen.findByText("trash list failed")).toBeVisible();
  const retry = screen.getByRole("button", { name: "다시 시도" });
  expect(retry).not.toBeDisabled();
  await user.click(retry);

  expect(await screen.findByText("asset-1.png")).toBeVisible();
  expect(gateway.getTrashPolicy).toHaveBeenCalledTimes(2);
});

it("retries after policy loading fails while listing trash is still pending", async () => {
  const neverPage = new Promise<TrashPage>(() => undefined);
  const user = userEvent.setup();
  const gateway = createGateway();
  vi.mocked(gateway.listTrash)
    .mockReturnValueOnce(neverPage)
    .mockResolvedValueOnce({ items: [{ asset: asset(), trashedAt: "2026-07-20T00:00:00Z", purgeAt: null }], nextCursor: null, totalCount: 1, totalBytes: 1_024 });
  vi.mocked(gateway.getTrashPolicy)
    .mockRejectedValueOnce(new Error("policy failed"))
    .mockResolvedValueOnce({ retentionDays: 30 });

  renderTrash(<TrashBrowser />, gateway);
  await userEvent.click(screen.getByText("보존 설정", { exact: false, selector: "summary" }));

  expect(await screen.findByText("policy failed")).toBeVisible();
  const retry = screen.getByRole("button", { name: "다시 시도" });
  expect(retry).not.toBeDisabled();
  await user.click(retry);

  expect(await screen.findByText("asset-1.png")).toBeVisible();
  expect(gateway.listTrash).toHaveBeenCalledTimes(2);
});

it("ignores an older policy completion after a newer refresh", async () => {
  let resolveInitialPolicy!: (value: { retentionDays: number | null }) => void;
  const initialPolicy = new Promise<{ retentionDays: number | null }>((resolve) => { resolveInitialPolicy = resolve; });
  const user = userEvent.setup();
  const gateway = createGateway();
  vi.mocked(gateway.getTrashPolicy)
    .mockReturnValueOnce(initialPolicy)
    .mockResolvedValueOnce({ retentionDays: 45 });

  renderTrash(<TrashBrowser />, gateway);
  await userEvent.click(screen.getByText("보존 설정", { exact: false, selector: "summary" }));

  await user.click(await screen.findByRole("button", { name: "복원" }));
  await waitFor(() => expect(gateway.getTrashPolicy).toHaveBeenCalledTimes(2));
  await act(async () => { resolveInitialPolicy({ retentionDays: 30 }); await initialPolicy; });

  expect(await screen.findByRole("spinbutton", { name: "보존 기간" })).toHaveValue(45);
});

it("disables conflicting trash mutations while a restore is pending", async () => {
  let resolveRestore!: () => void;
  const pendingRestore = new Promise<void>((resolve) => { resolveRestore = resolve; });
  const user = userEvent.setup();
  const gateway = createGateway();
  vi.mocked(gateway.restoreAsset).mockReturnValue(pendingRestore);

  renderTrash(<TrashBrowser />, gateway);
  await userEvent.click(screen.getByText("보존 설정", { exact: false, selector: "summary" }));

  await user.click(await screen.findByRole("button", { name: "복원" }));
  expect(screen.getByRole("button", { name: "복원" })).toBeDisabled();
  expect(screen.getByRole("button", { name: "휴지통 비우기" })).toBeDisabled();
  expect(screen.getByRole("checkbox", { name: "자동 삭제" })).toBeDisabled();

  await act(async () => { resolveRestore(); await pendingRestore; });
});

it("disables automatic deletion and saves a valid retention period", async () => {
  const user = userEvent.setup();
  const gateway = createGateway();
  renderTrash(<TrashBrowser />, gateway);
  await userEvent.click(screen.getByText("보존 설정", { exact: false, selector: "summary" }));

  await screen.findByRole("checkbox", { name: "자동 삭제" });
  await user.click(screen.getByRole("checkbox", { name: "자동 삭제" }));
  expect(gateway.setTrashPolicy).toHaveBeenCalledWith({ retentionDays: null });

  await user.click(screen.getByRole("checkbox", { name: "자동 삭제" }));
  const input = screen.getByRole("spinbutton", { name: "보존 기간" });
  await user.clear(input);
  await user.type(input, "45");
  await user.click(screen.getByRole("button", { name: "저장" }));
  expect(gateway.setTrashPolicy).toHaveBeenLastCalledWith({ retentionDays: 45 });
});

it("confirms emptying the whole trash using the server totals", async () => {
  const user = userEvent.setup();
  const gateway = createGateway();
  renderTrash(<TrashBrowser />, gateway);
  await userEvent.click(screen.getByText("보존 설정", { exact: false, selector: "summary" }));

  await screen.findByText("asset-1.png");
  await user.click(screen.getByRole("button", { name: "휴지통 비우기" }));
  expect(screen.getByRole("dialog")).toHaveTextContent("2개 (3.0 KB)를 영구 삭제합니다.");
  await user.click(screen.getByRole("button", { name: "영구 삭제" }));
  expect(gateway.emptyTrash).toHaveBeenCalledOnce();
});

it("uses the context chrome toolbar with the empty action in the index", async () => {
  const gateway = createGateway();
  const { container } = renderTrash(<TrashBrowser />, gateway);
  await userEvent.click(screen.getByText("보존 설정", { exact: false, selector: "summary" }));
  expect(await screen.findByRole("toolbar")).toBeInTheDocument();
  expect(container.querySelector(".view-toolbar--context")).toBeInTheDocument();
  expect(container.querySelector(".view-toolbar__actions")).not.toBeInTheDocument();
});

function createGateway(): LibraryGateway {
  return {
    resetJapaneseCatalogCheckpoint: vi.fn(),
    getIgdbCredentialStatus: vi.fn(),
    setIgdbCredentials: vi.fn(),
    deleteIgdbCredentials: vi.fn(),
    searchIgdbGames: vi.fn(),
    previewIgdbGame: vi.fn(),
    applyIgdbGame: vi.fn(),
    refreshIgdbGame: vi.fn(),
    getIgdbConnection: vi.fn(),
    replaceIgdbGameArtwork: vi.fn(),
    getStashdbCredentialStatus: vi.fn().mockResolvedValue({ configured: false }),
    setStashdbCredentials: vi.fn(),
    deleteStashdbCredentials: vi.fn(),
    getTmdbCredentialStatus: vi.fn(),
    setTmdbToken: vi.fn(),
    deleteTmdbToken: vi.fn(),
    searchTmdbMovies: vi.fn(),
    previewTmdbMovie: vi.fn(),
    applyTmdbMovie: vi.fn(),
    refreshTmdbMovie: vi.fn(),
    getTmdbConnection: vi.fn(),
    replaceTmdbMovieArtwork: vi.fn(),
    openLibrary: vi.fn(), importVckCatalog: vi.fn(), getOnlineCatalogStatus: vi.fn(), getCatalogVisibilityPolicy: vi.fn().mockResolvedValue({ hiddenCategories: [], blockedTags: [] }), setCatalogCategoryHidden: vi.fn(), setCatalogTagBlocked: vi.fn(), searchCatalogGroups: vi.fn(), getCatalogGroupEditions: vi.fn(), setCatalogGroupRepresentative: vi.fn(), listCatalogReview: vi.fn(), generateCatalogReview: vi.fn(), decideCatalogReview: vi.fn(), searchOnlineCatalog: vi.fn(), suggestOnlineCatalog: vi.fn(), updateOnlineCatalog: vi.fn(), setOnlineCatalogUpdateSettings: vi.fn(), runDueOnlineCatalogUpdate: vi.fn(), getCloudCaptureSettings: vi.fn().mockResolvedValue({ enabled: false, apiBaseUrl: null, tokenConfigured: false }), setCloudCaptureSettings: vi.fn(), setCloudApiToken: vi.fn(), deleteCloudApiToken: vi.fn(), testCloudCaptureConnection: vi.fn().mockResolvedValue({ pendingCount: 0 }), runDueCloudCaptureSync: vi.fn().mockResolvedValue({ attempted: 0, acknowledged: 0, failed: 0, reviewPending: 0, added: 0, videoAdded: 0, classificationChanged: 0 }), cloudBackfillPreflight: vi.fn(), cloudBackfillSeed: vi.fn(), cloudBackfillRunCycle: vi.fn(), cloudBackfillProgress: vi.fn(), cloudBackfillRetryFailed: vi.fn(), getOnlineCatalogWorkDetail: vi.fn(), setOnlineCatalogBookmark: vi.fn(), resolveOnlineCatalogWork: vi.fn(), getRemoteReadingProgress: vi.fn(), saveRemoteReadingProgress: vi.fn(), clearRemoteMangaCache: vi.fn(), getExtensionConnection: vi.fn(), listClassifications: vi.fn(),
    listAlbums: vi.fn().mockResolvedValue([]), createAlbum: vi.fn(), renameAlbum: vi.fn(), moveAlbum: vi.fn(), updateAlbumAppearance: vi.fn(), deleteAlbum: vi.fn(),
    createClassification: vi.fn(), renameClassification: vi.fn(), moveClassification: vi.fn(), updateClassificationAppearance: vi.fn(),
    deleteClassification: vi.fn(), listAssets: vi.fn(), listAssetDateBuckets: vi.fn().mockResolvedValue([]), indexMissingSimilarityHashes: vi.fn(),
    listAssetCreators: vi.fn().mockResolvedValue([]),
    getRevisitSlate: vi.fn().mockResolvedValue({ localDate: "", createdAt: "", revision: 0, bundles: [] }),
    prepareRevisitColorBundle: vi.fn().mockResolvedValue(null),
    reshuffleRevisitBundle: vi.fn().mockResolvedValue({ localDate: "", createdAt: "", revision: 0, bundles: [] }),
    reshuffleRevisitSlate: vi.fn().mockResolvedValue({ localDate: "", createdAt: "", revision: 0, bundles: [] }),
    recordAssetOpened: vi.fn().mockResolvedValue(undefined),
    recordAssetsExposed: vi.fn().mockResolvedValue(undefined),
    setRevisitPreference: vi.fn().mockResolvedValue(undefined),
    listSimilarityReviews: vi.fn(), decideSimilarityReview: vi.fn(), getAsset: vi.fn(), updateAssetMetadata: vi.fn(), setAssetFavorite: vi.fn(), setAssetsFavorite: vi.fn(),
    getAssetClassifications: vi.fn(), setAssetClassification: vi.fn(), patchAssetAlbums: vi.fn(), getAssetAlbums: vi.fn().mockResolvedValue([]), ingestMedia: vi.fn(),
    listCollections: vi.fn().mockResolvedValue([]), searchMangaDex: vi.fn(), previewMangaDex: vi.fn(), applyMangaDex: vi.fn(), refreshMangaDex: vi.fn(), getMangaDexConnection: vi.fn().mockResolvedValue(null), createCollection: vi.fn(), updateCollection: vi.fn(), deleteCollection: vi.fn(), setCollectionCover: vi.fn(), setCollectionShowcase: vi.fn(), getAssetCollections: vi.fn().mockResolvedValue([]), patchAssetCollections: vi.fn(),
    preparePendingVideos: vi.fn(), retryVideoPreparation: vi.fn(), inspectBookImport: vi.fn(), importBookCollections: vi.fn(), getCollectionSourceRoot: vi.fn(), setCollectionSourceRoot: vi.fn(), importCollectionArtworks: vi.fn().mockResolvedValue(0),
  listCollectionWorkArtworks: vi.fn().mockResolvedValue([]), listCollectionCovers: vi.fn(), listCollectionVolumes: vi.fn(), syncMangaDexVolumeCovers: vi.fn(), inspectLegacyPackageMigration: vi.fn(), executeLegacyPackageMigration: vi.fn(), getKakaoCredentialStatus: vi.fn(), setKakaoApiKey: vi.fn(), deleteKakaoApiKey: vi.fn(), searchKakao: vi.fn(), applyKakao: vi.fn(), refreshKakao: vi.fn(), getBookConnection: vi.fn(), getReleaseWatchStatus: vi.fn().mockResolvedValue({ enabled: false, lastCheckedAt: null }), setReleaseWatchEnabled: vi.fn().mockResolvedValue({ enabled: false, lastCheckedAt: null }), takeUnreadReleaseChanges: vi.fn().mockResolvedValue([]), listUnreadReleaseChanges: vi.fn().mockResolvedValue([]), runDueReleaseWatch: vi.fn().mockResolvedValue({ checked: 0, changedCollections: 0, skipped: 0, stopReason: null }),
    getMangaRoot: vi.fn().mockResolvedValue(null), setMangaRoot: vi.fn().mockResolvedValue(undefined), scanManga: vi.fn().mockResolvedValue(0), listMangaSeries: vi.fn().mockResolvedValue([]),
    trashAssets: vi.fn(), restoreAsset: vi.fn(), restoreAssets: vi.fn(),
    listTrash: vi.fn().mockResolvedValue({
      items: [{ asset: asset(), trashedAt: "2026-07-20T00:00:00Z", purgeAt: new Date(Date.now() + 12 * 86_400_000).toISOString() }],
      nextCursor: null,
      totalCount: 2,
      totalBytes: 3_072,
    }),
    emptyTrash: vi.fn().mockResolvedValue({ deletedCount: 2, failedAssetIds: [] }),
    getTrashPolicy: vi.fn().mockResolvedValue({ retentionDays: 30 }),
    setTrashPolicy: vi.fn().mockResolvedValue(undefined),
    ensureDailyBackup: vi.fn(), listMetadataBackups: vi.fn(),
    restoreMetadataBackup: vi.fn(), purgeExpiredTrash: vi.fn(),
  };
}

function asset() {
  return {
    id: "asset-1", title: null, originalName: "asset-1.png", byteSize: 1_024,
    width: 200, height: 100, collectedAt: "2026-07-20T00:00:00Z", favorite: false, sourceUrl: null,
    sourcePublishedAt: null, creatorName: null, creatorHandle: null, creatorUrl: null,
    importSource: null, importBatchId: null, originalModifiedAt: null,
    media: { kind: "image" as const },
  };
}

it("keeps policy collapsed and renders only a trash thumbnail", async () => {
  renderTrash(<TrashBrowser />);
  const image = await screen.findByRole("img", { name: "휴지통 자산 미리보기" });
  expect(image).toHaveAttribute("src", "http://lakomics.localhost/trash-thumbnail/asset-1");
  expect(document.querySelector("details")).not.toHaveAttribute("open");
});

it("does not request trash thumbnails in privacy mode", async () => {
  render(<PrivacyProvider privacyMode setPrivacyMode={() => {}}><LibraryProvider gateway={createGateway()}><TrashBrowser /></LibraryProvider></PrivacyProvider>);
  await screen.findByText("asset-1.png");
  expect(document.querySelector("img")).toBeNull();
  expect(screen.getByRole("img", { name: "비공개 모드" })).toBeVisible();
});

it("renders the shared deletion date", async () => {
  const gateway = createGateway();
  vi.mocked(gateway.listTrash).mockResolvedValue({ items: [{ asset: asset(), trashedAt: "2025-07-20T12:00:00", purgeAt: null }], nextCursor: null, totalCount: 1, totalBytes: 1024 });
  renderTrash(<TrashBrowser />, gateway);
  expect(await screen.findByText("옮긴 날 2025.7.20")).toBeInTheDocument();
});

function collectionTrash(restorePending = false): CollectionTrashPage {
  return { libraryId: "library", epoch: 1, hasMore: false, items: [{ workId: "work", type: "manga", name: "작품", trashedAt: "2026-10-06T00:00:00Z", purgeAt: "2026-11-05T00:00:00Z", entityRevision: 2, restorePending }] };
}

it("remembers the section and queues a restore once while showing 대기", async () => {
  const gateway = createGateway();
  gateway.listCollectionTrash = vi.fn().mockResolvedValue(collectionTrash());
  gateway.restoreCollectionWork = vi.fn().mockImplementation(() => {
    vi.mocked(gateway.listCollectionTrash!).mockResolvedValue(collectionTrash(true));
    return Promise.resolve();
  });
  let onSync!: () => void;
  gateway.subscribeCollectionsChanged = vi.fn(handler => { onSync = handler; return () => {}; });
  const mounted = renderTrash(<TrashBrowser />, gateway);
  await screen.findByText("asset-1.png");
  await userEvent.click(screen.getByRole("tab", { name: "컬렉션 1" }));
  const restore = await screen.findByRole("button", { name: "작품 되살리기" });
  expect(screen.queryByRole("button", { name: "휴지통 비우기" })).not.toBeInTheDocument();
  await userEvent.click(restore);
  await waitFor(() => expect(restore).toBeDisabled());
  await userEvent.click(restore);
  expect(gateway.restoreCollectionWork).toHaveBeenCalledTimes(1);
  expect(gateway.restoreCollectionWork).toHaveBeenCalledWith("work", 2, "library", 1);
  expect(screen.getByText("대기")).toBeVisible();
  vi.mocked(gateway.listCollectionTrash).mockResolvedValue({ ...collectionTrash(), items: [] });
  act(() => { onSync(); });
  await waitFor(() => expect(screen.queryByRole("button", { name: "작품 되살리기" })).not.toBeInTheDocument());
  vi.mocked(gateway.listCollectionTrash).mockResolvedValue(collectionTrash(true));
  mounted.unmount();
  renderTrash(<TrashBrowser />, gateway);
  expect(screen.getByRole("tab", { name: /컬렉션/ })).toHaveAttribute("aria-selected", "true");
  expect(await screen.findByRole("button", { name: "작품 되살리기" })).toBeDisabled();
});

it("holds the old content inert until the next section is ready and preserves rows on reload", async () => {
  let resolve!: (value: CollectionTrashPage) => void;
  const gateway = createGateway();
  gateway.listCollectionTrash = vi.fn().mockReturnValue(new Promise<CollectionTrashPage>(done => { resolve = done; }));
  renderTrash(<TrashBrowser />, gateway);
  const asset = await screen.findByText("asset-1.png");
  await userEvent.click(screen.getByRole("tab", { name: "컬렉션" }));
  expect(asset).toBeVisible();
  expect(asset.closest("[inert]")).not.toBeNull();
  await act(async () => { resolve(collectionTrash()); });
  expect(await screen.findByText("작품")).toBeVisible();
  expect(asset).not.toBeVisible();
  vi.mocked(gateway.listCollectionTrash).mockRejectedValueOnce(new Error("연결 실패"));
  act(() => { window.dispatchEvent(new Event("focus")); });
  expect(await screen.findByText("연결 실패")).toBeVisible();
  vi.mocked(gateway.listCollectionTrash).mockReturnValueOnce(new Promise<CollectionTrashPage>(done => { resolve = done; }));
  await userEvent.click(screen.getByRole("button", { name: "다시 시도" }));
  expect(screen.getByText("작품")).toBeVisible();
  await act(async () => { resolve({ ...collectionTrash(), items: [] }); });
  await waitFor(() => expect(screen.queryByRole("button", { name: "작품 되살리기" })).not.toBeInTheDocument());
});

it("shows a one-line inactive authority error and retries", async () => {
  localStorage.setItem(TRASH_SECTION_STORAGE_KEY, "collections");
  const gateway = createGateway();
  gateway.listCollectionTrash = vi.fn().mockRejectedValueOnce(new Error("컬렉션 연결을 확인해 주세요.")).mockResolvedValueOnce(collectionTrash());
  renderTrash(<TrashBrowser />, gateway);
  expect(await screen.findByText("컬렉션 연결을 확인해 주세요.")).toBeVisible();
  await userEvent.click(screen.getByRole("button", { name: "다시 시도" }));
  expect(await screen.findByText("작품")).toBeVisible();
});

it("restores deleted notes through the existing notes store without losing their content", async () => {
  const note: Note = { id: "note", title: "메모", body: "내용", pinned: true, deleted: true, createdAt: "2025-07-20T12:00:00", updatedAt: "2025-07-20T12:00:00", localRevision: 1, pending: false, conflict: false };
  let notes = [note];
  const request = vi.fn(async (operation: string, input: any) => {
    if (operation === "save") {
      const saved = { ...note, ...input, localRevision: 2 };
      notes = [saved];
      return saved;
    }
    return { unlocked: true, notes, lastSyncedAt: null };
  });
  const store = new NotesStore(request as NotesRequest);
  await store.load();
  render(<NotesTrashSection store={store} />);
  expect(screen.getByText("옮긴 날 2025.7.20")).toBeVisible();
  await userEvent.click(screen.getByRole("button", { name: "메모 되살리기" }));
  await waitFor(() => expect(request).toHaveBeenCalledWith("save", expect.objectContaining({ id: "note", deleted: false, pinned: true, body: "내용" })));
  expect(await screen.findByText("휴지통이 비어 있습니다")).toBeVisible();
});
