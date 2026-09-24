import { beforeEach, describe, expect, it, vi } from "vitest";

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));

vi.mock("@tauri-apps/api/core", () => ({ invoke, Channel: class { onmessage = () => {}; } }));
const { listen } = vi.hoisted(() => ({ listen: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen }));

import { libraryGateway } from "./client";
import { Channel } from "@tauri-apps/api/core";

it("supplies the required volume progress channel even without a listener", async () => {
  await libraryGateway.listCollectionVolumes("collection-1");
  expect(invoke).toHaveBeenLastCalledWith("list_collection_volumes", {
    collectionId: "collection-1",
    onProgress: expect.any(Channel),
  });
  const channel = invoke.mock.lastCall![1].onProgress;
  expect(() => channel.onmessage({ imported: 1, total: 2 })).not.toThrow();
});

it("forwards volume progress to an optional listener", async () => {
  const onProgress = vi.fn();
  await libraryGateway.listCollectionVolumes("collection-2", onProgress);
  expect(invoke).toHaveBeenLastCalledWith("list_collection_volumes", {
    collectionId: "collection-2",
    onProgress: expect.any(Channel),
  });
  invoke.mock.lastCall![1].onProgress.onmessage({ imported: 1, total: 2 });
  expect(onProgress).toHaveBeenCalledExactlyOnceWith({ imported: 1, total: 2 });
});

it("routes catalog review to explicit native commands", async () => {
  await libraryGateway.listCatalogReview();
  expect(invoke).toHaveBeenLastCalledWith("list_catalog_review");
  await libraryGateway.generateCatalogReview();
  expect(invoke).toHaveBeenLastCalledWith("generate_catalog_review");
  const query = { leftAnchor: "1", rightAnchor: "2", reviewToken: "displayed-evidence", decision: "split" as const };
  await libraryGateway.decideCatalogReview(query);
  expect(invoke).toHaveBeenLastCalledWith("decide_catalog_review", { query });
});

describe("libraryGateway similarity contract", () => {
  beforeEach(() => invoke.mockClear());

  it("uses the exact Tauri command names and camelCase payloads", async () => {
    await libraryGateway.indexMissingSimilarityHashes();
    await libraryGateway.getImageSimilarityScan?.();
    await libraryGateway.startImageSimilarityScan?.();
    await libraryGateway.runImageSimilarityScanBatch?.("scan-1");
    await libraryGateway.listSimilarityReviews({ after: null, limit: 20 });
    await libraryGateway.decideSimilarityReview({
      reviewId: "review-1",
      decision: "keep_both",
    });
    await libraryGateway.getAsset("asset-1");

    expect(invoke).toHaveBeenNthCalledWith(1, "index_missing_similarity_hashes");
    expect(invoke).toHaveBeenNthCalledWith(2, "get_image_similarity_scan");
    expect(invoke).toHaveBeenNthCalledWith(3, "start_image_similarity_scan");
    expect(invoke).toHaveBeenNthCalledWith(4, "run_image_similarity_scan_batch", { scanId: "scan-1" });
    expect(invoke).toHaveBeenNthCalledWith(5, "list_similarity_reviews", {
      after: null,
      limit: 20,
    });
    expect(invoke).toHaveBeenNthCalledWith(6, "decide_similarity_review", {
      request: { reviewId: "review-1", decision: "keep_both" },
    });
    expect(invoke).toHaveBeenNthCalledWith(7, "get_asset", {
      assetId: "asset-1",
    });
  });

  it("updates editable source metadata through one request payload", async () => {
    const request = {
      assetId: "asset-1",
      sourcePublishedAt: "2026-08-01T10:20:30Z",
      creatorName: "Example Artist",
      creatorHandle: "example",
      creatorUrl: "https://x.com/example",
    };

    await libraryGateway.updateAssetMetadata(request);

    expect(invoke).toHaveBeenCalledWith("update_asset_metadata", { request });
  });

  it("does not expose superseded single-item commands", () => {
    expect(libraryGateway).not.toHaveProperty("currentLibrary");
    expect(libraryGateway).not.toHaveProperty("trashAsset");
    expect(libraryGateway).not.toHaveProperty("setAssetClassifications");
  });
});

describe("libraryGateway classification appearance contract", () => {
  beforeEach(() => invoke.mockClear());

  it("uses the appearance command with camelCase payloads", async () => {
    await libraryGateway.updateClassificationAppearance(
      "folder-1",
      "photo",
      "pink",
    );

    expect(invoke).toHaveBeenCalledWith("update_classification_appearance", {
      id: "folder-1",
      iconKey: "photo",
      colorKey: "pink",
    });
  });
});

describe("libraryGateway album contract", () => {
  beforeEach(() => invoke.mockClear());

  it("uses album and single-folder commands with camelCase payloads", async () => {
    await libraryGateway.createAlbum({ name: "표지", parentId: null });
    await libraryGateway.patchAssetAlbums({
      assetIds: ["asset-1"],
      addAlbumIds: ["album-1"],
      removeAlbumIds: [],
    });
    await libraryGateway.setAssetClassification({
      assetIds: ["asset-1"],
      classificationId: "folder-1",
    });

    expect(invoke).toHaveBeenNthCalledWith(1, "create_album", {
      request: { name: "표지", parentId: null },
    });
    // An accepted Album mutation immediately tries to deliver its durable intent, so
    // the window where another device sees the old structure stays short.
    expect(invoke).toHaveBeenNthCalledWith(2, "flush_album_outbox");
    expect(invoke).toHaveBeenNthCalledWith(3, "patch_asset_albums", {
      patch: {
        assetIds: ["asset-1"],
        addAlbumIds: ["album-1"],
        removeAlbumIds: [],
      },
    });
    expect(invoke).toHaveBeenNthCalledWith(4, "flush_album_outbox");
    expect(invoke).toHaveBeenNthCalledWith(5, "set_asset_classification", {
      request: { assetIds: ["asset-1"], classificationId: "folder-1" },
    });
    // The Classification mutation flushes too, now that it owns a durable outbox.
    expect(invoke).toHaveBeenNthCalledWith(6, "flush_classification_outbox");
  });
});

describe("libraryGateway classification contract", () => {
  beforeEach(() => invoke.mockClear());

  it("flushes the Classification outbox after every mutation that can queue one", async () => {
    await libraryGateway.createClassification({ kind: "root", name: "게임", parentId: null });
    await libraryGateway.renameClassification("folder-1", "게임2");
    await libraryGateway.moveClassification("folder-1", null);
    await libraryGateway.updateClassificationAppearance("folder-1", "folder", "blue");
    await libraryGateway.deleteClassification("folder-1");
    await libraryGateway.setAssetClassification({
      assetIds: ["asset-1"],
      classificationId: "folder-1",
    });

    expect(invoke.mock.calls.map((call) => call[0])).toEqual([
      "create_classification",
      "flush_classification_outbox",
      "rename_classification",
      "flush_classification_outbox",
      "move_classification",
      "flush_classification_outbox",
      "update_classification_appearance",
      "flush_classification_outbox",
      "delete_classification",
      "flush_classification_outbox",
      "set_asset_classification",
      "flush_classification_outbox",
    ]);
    expect(invoke).toHaveBeenNthCalledWith(1, "create_classification", {
      request: { kind: "root", name: "게임", parentId: null },
    });
    expect(invoke).toHaveBeenNthCalledWith(11, "set_asset_classification", {
      request: { assetIds: ["asset-1"], classificationId: "folder-1" },
    });
  });

  it("resolves the local mutation even when the immediate flush fails", async () => {
    // The durable intent committed with the mutation, so a failed send is not a lost
    // edit. The background loop retries the identical operation id.
    invoke.mockImplementation(async (command: string) => {
      if (command === "flush_classification_outbox") throw new Error("offline");
      return undefined;
    });
    await expect(
      libraryGateway.renameClassification("folder-1", "게임2"),
    ).resolves.toBeUndefined();
    expect(invoke).toHaveBeenCalledWith("rename_classification", {
      id: "folder-1",
      name: "게임2",
    });
    invoke.mockReset();
  });

  it("resolves a mutation without waiting for a slow flush", async () => {
    // A successful local edit must not be as slow as the network. The optimistic write
    // and its outbox row are already committed when the mutation resolves; the kick is
    // what shortens the window another device sees the old state, so it must not be
    // something the user's edit waits on.
    let releaseFlush: (() => void) | undefined;
    invoke.mockImplementation(async (command: string) => {
      if (command === "flush_classification_outbox") {
        await new Promise<void>((resolve) => { releaseFlush = resolve; });
      }
      return undefined;
    });

    await expect(
      libraryGateway.renameClassification("folder-1", "게임2"),
    ).resolves.toBeUndefined();
    // The flush is still in flight, which is exactly the point: the edit resolved first.
    expect(releaseFlush).toBeDefined();
    releaseFlush?.();
    invoke.mockReset();
  });

  it("kicks delivery after the mutation instead of blocking on it", async () => {
    invoke.mockImplementation(async () => undefined);
    await libraryGateway.renameClassification("folder-1", "게임2");
    // The flush is attempted (so the durable intent is delivered promptly) but the
    // ordering is mutation-then-kick, never kick-around-mutation.
    expect(invoke.mock.calls.map((call) => call[0])).toEqual([
      "rename_classification",
      "flush_classification_outbox",
    ]);
  });

  it("never lets a rapid mutation wait on outbox delivery", async () => {
    // Single-flight is a native property now (`Library::flush_outbox_single_flight`), because
    // several independent callers deliver the same domain and a coalescer here could only
    // serialize the kicks against each other. What this layer still guarantees is that a
    // mutation never waits on delivery: every rapid edit resolves while its wake-up is held.
    const gates: Array<() => void> = [];
    let flushes = 0;
    invoke.mockImplementation(async (command: string) => {
      if (command !== "flush_classification_outbox") return undefined;
      flushes += 1;
      await new Promise<void>((resolve) => { gates.push(resolve); });
    });

    const edits = [1, 2, 3, 4, 5].map((index) =>
      libraryGateway.renameClassification(`folder-${index}`, `게임${index}`),
    );
    // All five resolve even though every flush is still parked.
    await expect(Promise.all(edits)).resolves.toHaveLength(5);
    expect(flushes).toBe(5);
    expect(gates).toHaveLength(5);
    gates.forEach((release) => release());
    invoke.mockReset();
  });

  it("exposes flush-first sync surfaces for Classification", async () => {
    await libraryGateway.reconcileClassificationAuthority!();
    await libraryGateway.flushClassificationOutbox!();
    await libraryGateway.classificationSyncStatus!();
    expect(invoke).toHaveBeenNthCalledWith(1, "reconcile_classification_authority");
    expect(invoke).toHaveBeenNthCalledWith(2, "flush_classification_outbox");
    expect(invoke).toHaveBeenNthCalledWith(3, "classification_sync_status");
  });
});

describe("libraryGateway video contract", () => {
  beforeEach(() => invoke.mockClear());

  it("uses the media ingest and video preparation commands", async () => {
    const request = {
      sourcePath: "C:\\input\\clip.webm",
      classificationId: "work-1",
      sourceUrl: "https://example.test/post",
      importSource: "direct" as const,
      importBatchId: "00000000-0000-4000-8000-000000000006",
    };

    await libraryGateway.ingestMedia(request);
    await libraryGateway.preparePendingVideos(1);
    await libraryGateway.retryVideoPreparation("video-1");

    expect(invoke).toHaveBeenNthCalledWith(1, "ingest_media", { request });
    expect(invoke).toHaveBeenNthCalledWith(2, "prepare_pending_videos", {
      limit: 1,
    });
    expect(invoke).toHaveBeenNthCalledWith(3, "retry_video_preparation", {
      assetId: "video-1",
    });
  });
});

describe("libraryGateway online catalog contract", () => {
  beforeEach(() => invoke.mockClear());

  it("maps catalog import, status, search, and suggestions", async () => {
    const query = {
      provider: "kHentai" as const,
      revealBlocked: false,
      text: "던전",
      sort: "latest" as const,
      scope: "all" as const,
      page: 0,
      pageSize: 48,
    };

    await libraryGateway.importVckCatalog("C:\\VCK");
    await libraryGateway.getOnlineCatalogStatus();
    await libraryGateway.searchOnlineCatalog(query);
    await libraryGateway.suggestOnlineCatalog("제독", 10);
    await libraryGateway.updateOnlineCatalog();
    await libraryGateway.setOnlineCatalogUpdateSettings(true, 21_600);
    await libraryGateway.runDueOnlineCatalogUpdate();
    const identity = { provider: "kHentai" as const, providerWorkId: "3" };
    await libraryGateway.getOnlineCatalogWorkDetail(identity);
    await libraryGateway.setOnlineCatalogBookmark(identity, true);
    await libraryGateway.resolveOnlineCatalogWork(identity);
    await libraryGateway.getRemoteReadingProgress(identity);
    await libraryGateway.saveRemoteReadingProgress({ ...identity, lastPage: 2, pageCount: 10, lastReadAt: "" });
    await libraryGateway.clearRemoteMangaCache();
    await libraryGateway.getCatalogVisibilityPolicy();
    await libraryGateway.setCatalogCategoryHidden(2, true);
    await libraryGateway.setCatalogTagBlocked(
      { namespace: "artist", value: "sample" },
      true,
    );

    expect(invoke).toHaveBeenNthCalledWith(1, "import_vck_catalog", {
      vckRoot: "C:\\VCK",
    });
    expect(invoke).toHaveBeenNthCalledWith(2, "get_online_catalog_status");
    expect(invoke).toHaveBeenNthCalledWith(3, "search_online_catalog", { query });
    expect(invoke).toHaveBeenNthCalledWith(4, "suggest_online_catalog", {
      text: "제독",
      limit: 10,
    });
    expect(invoke).toHaveBeenNthCalledWith(5, "update_online_catalog");
    expect(invoke).toHaveBeenNthCalledWith(6, "set_online_catalog_update_settings", {
      enabled: true,
      intervalSeconds: 21_600,
    });
    expect(invoke).toHaveBeenNthCalledWith(7, "run_due_online_catalog_update");
    expect(invoke).toHaveBeenNthCalledWith(8, "get_online_catalog_work_detail", { identity });
    expect(invoke).toHaveBeenNthCalledWith(9, "set_online_catalog_bookmark", {
      identity,
      bookmarked: true,
    });
    expect(invoke).toHaveBeenNthCalledWith(10, "flush_catalog_bookmark_outbox");
    expect(invoke).toHaveBeenNthCalledWith(11, "resolve_online_catalog_work", { identity });
    expect(invoke).toHaveBeenNthCalledWith(12, "get_remote_reading_progress", { identity });
    expect(invoke).toHaveBeenNthCalledWith(13, "save_remote_reading_progress", {
      progress: { ...identity, lastPage: 2, pageCount: 10, lastReadAt: "" },
    });
    expect(invoke).toHaveBeenNthCalledWith(14, "clear_remote_manga_cache");
    expect(invoke).toHaveBeenNthCalledWith(15, "get_catalog_visibility_policy");
    expect(invoke).toHaveBeenNthCalledWith(16, "set_catalog_category_hidden", {
      category: 2,
      hidden: true,
    });
    expect(invoke).toHaveBeenNthCalledWith(17, "set_catalog_tag_blocked", {
      tag: { namespace: "artist", value: "sample" },
      blocked: true,
    });
  });

  it("maps bookmark reconciliation and durable outbox commands", async () => {
    await libraryGateway.reconcileCatalogBookmarks?.();
    await libraryGateway.flushCatalogBookmarkOutbox?.();

    expect(invoke).toHaveBeenNthCalledWith(1, "reconcile_catalog_bookmarks");
    expect(invoke).toHaveBeenNthCalledWith(2, "flush_catalog_bookmark_outbox");
  });

  it("keeps legacy catalog update calls argument-free and forwards Japanese bounds", async () => {
    await libraryGateway.updateOnlineCatalog();
    await libraryGateway.updateOnlineCatalog("japanese", 1);
    await libraryGateway.runDueOnlineCatalogUpdate();
    await libraryGateway.runDueOnlineCatalogUpdate("japanese");

    expect(invoke).toHaveBeenNthCalledWith(1, "update_online_catalog");
    expect(invoke).toHaveBeenNthCalledWith(2, "update_online_catalog", {
      language: "japanese",
      maxPages: 1,
    });
    expect(invoke).toHaveBeenNthCalledWith(3, "run_due_online_catalog_update");
    expect(invoke).toHaveBeenNthCalledWith(4, "run_due_online_catalog_update", {
      language: "japanese",
    });
  });

  it("resets only the Japanese catalog checkpoint through its dedicated command", async () => {
    await libraryGateway.resetJapaneseCatalogCheckpoint();

    expect(invoke).toHaveBeenCalledWith("reset_japanese_catalog_checkpoint");
  });
});

describe("libraryGateway revisit contract", () => {
  beforeEach(() => invoke.mockClear());

  it("invokes revisit commands with stable payload names", async () => {
    await libraryGateway.getRevisitSlate("2026-08-30", "2026-08-30T03:00:00.000Z");
    expect(invoke).toHaveBeenCalledWith("get_revisit_slate", {
      localDate: "2026-08-30",
      nowUtc: "2026-08-30T03:00:00.000Z",
    });

    await libraryGateway.prepareRevisitColorBundle("2026-08-30", "2026-08-30T03:00:00.000Z", 7);
    expect(invoke).toHaveBeenCalledWith("prepare_revisit_color_bundle", {
      localDate: "2026-08-30", nowUtc: "2026-08-30T03:00:00.000Z", expectedRevision: 7,
    });

    await libraryGateway.reshuffleRevisitBundle("2026-08-30", "bundle-1");
    expect(invoke).toHaveBeenCalledWith("reshuffle_revisit_bundle", {
      localDate: "2026-08-30",
      bundleId: "bundle-1",
      nowUtc: expect.any(String),
    });

    await libraryGateway.reshuffleRevisitSlate("2026-08-30");
    expect(invoke).toHaveBeenCalledWith("reshuffle_revisit_slate", {
      localDate: "2026-08-30",
      nowUtc: expect.any(String),
    });

    await libraryGateway.recordAssetOpened("asset-1", "2026-08-30T03:00:00.000Z");
    expect(invoke).toHaveBeenCalledWith("record_asset_opened", {
      assetId: "asset-1",
      openedAt: "2026-08-30T03:00:00.000Z",
    });

    await libraryGateway.recordAssetsExposed(["asset-1"], "2026-08-30T03:00:00.000Z");
    expect(invoke).toHaveBeenCalledWith("record_assets_exposed", {
      assetIds: ["asset-1"],
      exposedAt: "2026-08-30T03:00:00.000Z",
    });

    await libraryGateway.setRevisitPreference({ kind: "bundle", bundleId: "bundle-1" });
    expect(invoke).toHaveBeenCalledWith("set_revisit_preference", {
      feedback: { kind: "bundle", bundleId: "bundle-1" },
    });
  });
});


describe("libraryGateway encrypted vault contract", () => {
  beforeEach(() => invoke.mockClear());

  it("uses stable commands and payloads for the encrypted vault", async () => {
    await libraryGateway.getEncryptedVaultStatus!();
    expect(invoke).toHaveBeenCalledWith("encrypted_vault_status");
    await libraryGateway.createEncryptedVault!("/media/usb", "pw", true);
    expect(invoke).toHaveBeenCalledWith("create_encrypted_vault", { root: "/media/usb", password: "pw", remember: true });
    await libraryGateway.unlockEncryptedVault!({ kind: "recoveryKey", value: "ab" }, false);
    expect(invoke).toHaveBeenCalledWith("unlock_encrypted_vault", { secret: { kind: "recoveryKey", value: "ab" }, remember: false });
    await libraryGateway.lockEncryptedVault!();
    expect(invoke).toHaveBeenCalledWith("lock_encrypted_vault");
    await libraryGateway.forgetEncryptedVaultKey!();
    expect(invoke).toHaveBeenCalledWith("forget_encrypted_vault_key");
    await libraryGateway.changeEncryptedVaultPassword!({ kind: "password", value: "old" }, "new");
    expect(invoke).toHaveBeenCalledWith("change_encrypted_vault_password", { current: { kind: "password", value: "old" }, newPassword: "new" });
    const query = { kind: null, offset: 0, limit: 80 } as const;
    await libraryGateway.listEncryptedVaultItems!(query);
    expect(invoke).toHaveBeenCalledWith("list_encrypted_vault_items", { query });
    await libraryGateway.setEncryptedVaultTitle!("item-1", "제목");
    expect(invoke).toHaveBeenCalledWith("set_encrypted_vault_title", { itemId: "item-1", title: "제목" });
    await libraryGateway.previewEncryptedVaultSidecarCleanup!();
    expect(invoke).toHaveBeenCalledWith("preview_encrypted_vault_sidecar_cleanup");
    await libraryGateway.applyEncryptedVaultSidecarCleanup!();
    expect(invoke).toHaveBeenCalledWith("apply_encrypted_vault_sidecar_cleanup");
    const onProgress = vi.fn();
    await libraryGateway.importIntoEncryptedVault!("/home/me/old", onProgress);
    expect(invoke).toHaveBeenCalledWith("import_into_encrypted_vault", { sourceFolder: "/home/me/old", onProgress: expect.any(Channel) });
    invoke.mock.lastCall![1].onProgress.onmessage({ processed: 1, total: 2, imported: 1, skipped: 0, failed: 0 });
    expect(onProgress).toHaveBeenCalledWith({ processed: 1, total: 2, imported: 1, skipped: 0, failed: 0 });
  });
});

it("streams grouped count through Channel and sends edition requests", async () => {
  const query = { provider: "kHentai" as const, text: "love", sort: "latest" as const, scope: "all" as const, page: 0, pageSize: 48 };
  const onEvent = vi.fn();
  await libraryGateway.searchCatalogGroups(query, onEvent);
  const payload = invoke.mock.calls[invoke.mock.calls.length - 1][1];
  expect(invoke).toHaveBeenLastCalledWith("search_catalog_groups", { query, onEvent: expect.any(Object) });
  payload.onEvent.onmessage({ type: "count", totalCount: 0 });
  expect(onEvent).toHaveBeenCalledWith({ type: "count", totalCount: 0 });
  const editions = { provider: "kHentai" as const, groupId: "uuid", language: "korean" as const, revealBlocked: false, page: 0, pageSize: 40 };
  await libraryGateway.getCatalogGroupEditions(editions);
  expect(invoke).toHaveBeenLastCalledWith("get_catalog_group_editions", { query: editions });
  const preference = { provider: "kHentai" as const, groupId: "uuid", selectedProviderWorkId: null };
  await libraryGateway.setCatalogGroupRepresentative(preference);
  expect(invoke).toHaveBeenLastCalledWith("set_catalog_group_representative", { query: preference });
});


it("streams committed cloud captures through the native channel", async () => {
  const onProgress = vi.fn();
  await libraryGateway.runDueCloudCaptureSync(onProgress);
  expect(invoke).toHaveBeenLastCalledWith("run_due_cloud_capture_sync", { onProgress: expect.any(Channel) });
  const outcome = { status: "exact_duplicate", existingAssetId: "asset", classificationChanged: true };
  invoke.mock.lastCall![1].onProgress.onmessage(outcome);
  expect(onProgress).toHaveBeenCalledExactlyOnceWith(outcome);
});

it("forwards the native collections-changed event and unlistens on cleanup", async () => {
  const unlisten = vi.fn();
  let emit: () => void = () => {};
  listen.mockImplementation(async (_name: string, callback: () => void) => { emit = callback; return unlisten; });
  const handler = vi.fn();
  const stop = libraryGateway.subscribeCollectionsChanged!(handler);
  expect(listen).toHaveBeenCalledWith("library://collections-changed", expect.any(Function));
  await Promise.resolve(); await Promise.resolve();
  emit();
  expect(handler).toHaveBeenCalledOnce();
  stop();
  expect(unlisten).toHaveBeenCalledOnce();
});

it("sends the edit dialog's personal base with a collection update", async () => {
  const input = { name: "A", description: null, type: "manga" as const, year: null, author: null, developer: null, publisher: null, platforms: null,
    productionCompany: null, releaseDate: null, director: null, externalScore: null, myScore: 4, personalBase: { myScore: 3, description: "memo" } };
  await libraryGateway.updateCollection("c", input);
  expect(invoke).toHaveBeenLastCalledWith("update_collection", { id: "c", request: input });
});
