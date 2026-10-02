vi.mock("./physical/collectibleRuntime", async importOriginal => ({ ...await importOriginal<typeof import("./physical/collectibleRuntime")>(), acquireCover: (_request: unknown, callback: (value: null) => void) => { callback(null); return () => undefined; } }));
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { LibraryProvider } from "../library/LibraryContext";
import type { CollectionSummary, LibraryGateway, LaunchBoxSpineBatchResult, LaunchBoxSpineProgress, LaunchBoxSpineOutcome } from "../library/types";
import { CollectionBrowser } from "./CollectionBrowser";
import { createDefaultCollectionLibraryState } from "./collectionLibrary";
import { requestMissingGameSpine, useLaunchBoxSpineBatch } from "./launchBoxSpines";
import { CollectionShelfCase } from "./case/LightCase";
import { resetShelfCasesForTests } from "./case/shelfCaseInfo";
afterEach(() => { cleanup(); resetShelfCasesForTests(); });
const game = { id: "a", name: "게임", type: "game", updatedAt: "r", platforms: "Switch 2", unreadReleaseCount: 0, createdAt: "r", showcase: false } as CollectionSummary;
const outcome = (id: string, status: LaunchBoxSpineOutcome["status"]): LaunchBoxSpineOutcome => ({ collectionId: id, status, reason: "", artworkId: null, databaseId: null, platform: null, fileName: null, region: null, cached: false });
function setup() {
  const gateway = { listCollectionWorkArtworks: vi.fn().mockResolvedValue([]), listCollectionShelfCases: vi.fn().mockResolvedValue([]), fetchLaunchBoxSpines: vi.fn<NonNullable<LibraryGateway["fetchLaunchBoxSpines"]>>() };
  const changed = vi.fn().mockResolvedValue(undefined);
  function Browser() {
    return <LibraryProvider gateway={gateway as unknown as LibraryGateway}><CollectionBrowser
      collections={[game, { ...game, id: "b" }, { ...game, id: "c" }, { ...game, id: "d" }, { ...game, id: "e" }, { ...game, id: "manga", type: "manga" }]} typeFilter="game" showcase={false}
      libraryState={createDefaultCollectionLibraryState().game} onLibraryStateChange={vi.fn()} onViewChange={vi.fn()} onChanged={changed} /></LibraryProvider>;
  }
  return { gateway, changed, Browser };
}
async function start() {
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "작품 관리" }));
  await user.click(screen.getByRole("menuitem", { name: "책등 받기" }));
  return user;
}
it("follows the cursor, displays cumulative progress, prevents another batch and summarises", async () => {
  const { gateway, changed, Browser } = setup();
  let finish!: (value: LaunchBoxSpineBatchResult) => void;
  let report!: (value: LaunchBoxSpineProgress) => void;
  let job = "";
  gateway.fetchLaunchBoxSpines.mockImplementation(async (request, progress) => {
    if (request.action === "cancel") throw new Error("unexpected cancel");
    if (request.informationOnly) return { jobId: request.jobId, outcomes: [], nextCursor: null, hasMore: false, cancelled: false, platformsFilled: 0 };
    if (!request.afterCollectionId) return { jobId: request.jobId, outcomes: [outcome("a", "matched")], nextCursor: "a", hasMore: true, cancelled: false };
    job = request.jobId; report = progress!;
    return new Promise(resolve => { finish = resolve; });
  });
  render(<Browser />); const user = await start();
  await waitFor(() => expect(gateway.fetchLaunchBoxSpines).toHaveBeenCalledTimes(3));
  expect(gateway.fetchLaunchBoxSpines.mock.calls[0][0]).toMatchObject({ action: "run", limit: 50, informationOnly: true });
  expect(gateway.fetchLaunchBoxSpines.mock.calls[1][0]).toMatchObject({ action: "run", limit: 50 });
  expect(gateway.fetchLaunchBoxSpines.mock.calls[2][0]).toMatchObject({ action: "run", limit: 50, afterCollectionId: "a" });
  expect(gateway.listCollectionShelfCases.mock.calls.flatMap(args => args[0])).not.toContain("manga");
  act(() => report({ jobId: job, phase: "game_completed", processed: 1, total: 2, outcome: outcome("b", "no_match") }));
  expect(document.querySelector(".collection-toolbar__spine-status")).toHaveTextContent(/^책등 2\/5$/);
  await user.click(screen.getByRole("button", { name: "작품 관리" }));
  expect(screen.getByRole("menuitem", { name: "책등 받기" })).toHaveAttribute("aria-disabled", "true");
  await user.keyboard("{Escape}");
  await act(async () => finish({ jobId: job, outcomes: [outcome("b", "no_match"), outcome("c", "ambiguous"), outcome("d", "failed"), outcome("e", "skipped")], nextCursor: "e", hasMore: false, cancelled: false }));
  expect(screen.getByText("책등 1개 받음 · 못 찾음 1 · 애매함 1 · 실패 1 · 플랫폼 0개 채움")).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "취소" })).toBeNull();
  expect(changed).toHaveBeenCalledOnce();
});
it("cancels the active job and stops before another cursor call", async () => {
  const { gateway, Browser } = setup();
  let finish!: (value: LaunchBoxSpineBatchResult) => void;
  let job = "";
  gateway.fetchLaunchBoxSpines.mockImplementation(async request => {
    if (request.action === "cancel") return { jobId: request.jobId, outcomes: [], cancelled: true, nextCursor: null, hasMore: false };
    job = request.jobId; return new Promise(resolve => { finish = resolve; });
  });
  render(<Browser />); const user = await start();
  await waitFor(() => expect(gateway.fetchLaunchBoxSpines).toHaveBeenCalledOnce());
  await user.click(screen.getByRole("button", { name: "취소" }));
  expect(gateway.fetchLaunchBoxSpines).toHaveBeenLastCalledWith({ action: "cancel", jobId: job });
  expect(screen.getByRole("button", { name: "취소" })).toBeDisabled();
  await act(async () => finish({ jobId: job, outcomes: [outcome("a", "matched")], cancelled: true, nextCursor: "a", hasMore: true }));
  expect(gateway.fetchLaunchBoxSpines).toHaveBeenCalledTimes(2);
  expect(screen.getByText("책등 0개 받음 · 못 찾음 0 · 애매함 0 · 실패 0 · 플랫폼 0개 채움 · 취소됨")).toBeInTheDocument();
});
it("uses the shared toast for command errors", async () => {
  const { gateway, Browser } = setup(); gateway.fetchLaunchBoxSpines.mockRejectedValue(new Error("요청 실패"));
  render(<Browser />); await start();
  expect(await screen.findByRole("alert")).toHaveClass("ui-toast");
  expect(screen.queryByRole("dialog")).toBeNull();
});
it("refreshes the matched light case without changing the collection timestamp", async () => {
  const gateway = { listCollectionShelfCases: vi.fn().mockResolvedValue([]), fetchLaunchBoxSpine: vi.fn().mockResolvedValue(outcome("a", "matched")) } as unknown as LibraryGateway;
  const { container } = render(<LibraryProvider gateway={gateway}><CollectionShelfCase collection={game} front={null} privacy={false} active selected={false} /></LibraryProvider>);
  await waitFor(() => expect(gateway.listCollectionShelfCases).toHaveBeenCalledOnce());
  vi.mocked(gateway.listCollectionShelfCases!).mockResolvedValue([{ collectionId: "a", ownedPlatform: null, spineArtworkId: "spine" }]);
  await act(async () => { await requestMissingGameSpine(gateway, "", game, []); });
  await waitFor(() => expect(gateway.listCollectionShelfCases).toHaveBeenCalledTimes(2));
  // Secondary shelf art mounts two frames after the front settles (no front here).
  const image = await waitFor(() => { const found = container.querySelector<HTMLImageElement>('img[src*="spine"]'); expect(found).not.toBeNull(); return found!; });
  expect(container.querySelector("[data-spine-template]")).not.toBeNull();
  await act(async () => fireEvent.load(image));
  expect(image).toBeVisible(); expect(container.querySelector("[data-spine-template]")).toBeNull();
});
it("excludes manga and scopes single attempts to their library", async () => {
  const gateway = { fetchLaunchBoxSpine: vi.fn().mockResolvedValue(outcome("a", "no_match")) } as unknown as LibraryGateway;
  expect(requestMissingGameSpine(gateway, "one", { ...game, type: "manga" }, [])).toBeNull();
  await requestMissingGameSpine(gateway, "one", game, []); await requestMissingGameSpine(gateway, "one", game, []);
  expect(gateway.fetchLaunchBoxSpine).toHaveBeenCalledOnce();
  await requestMissingGameSpine(gateway, "two", game, []);
  expect(gateway.fetchLaunchBoxSpine).toHaveBeenCalledTimes(2);
});

it("retains rejected single commands as attempts for the rest of the session", async () => {
  const gateway = { fetchLaunchBoxSpine: vi.fn().mockRejectedValue(new Error("요청 실패")) } as unknown as LibraryGateway;
  await expect(requestMissingGameSpine(gateway, "", game, [])).rejects.toThrow("요청 실패");
  await expect(requestMissingGameSpine(gateway, "", game, [])).rejects.toThrow("요청 실패");
  expect(gateway.fetchLaunchBoxSpine).toHaveBeenCalledOnce();
});

it("counts all visited games across cursor pages, including existing spines", async () => {
  const { gateway } = setup();
  gateway.listCollectionWorkArtworks.mockResolvedValue([{ id: "existing", kind: "spine", selected: true }]);
  let finish!: (value: LaunchBoxSpineBatchResult) => void;
  let report!: (value: LaunchBoxSpineProgress) => void;
  let job = "";
  gateway.fetchLaunchBoxSpines.mockImplementation(async (request, progress) => {
    if (request.action === "cancel") throw new Error("unexpected cancel");
    if (request.informationOnly) return { jobId: request.jobId, outcomes: [], nextCursor: null, hasMore: false, cancelled: false, platformsFilled: 0 };
    if (!request.afterCollectionId) return { jobId: request.jobId, outcomes: [outcome("a", "skipped"), outcome("b", "no_match")], nextCursor: "b", hasMore: true, cancelled: false };
    job = request.jobId; report = progress!;
    return new Promise(resolve => { finish = resolve; });
  });
  const { result } = renderHook(() => useLaunchBoxSpineBatch(gateway as unknown as LibraryGateway, "count-test"));
  const collections = ["a", "b", "c", "d", "e"].map(id => ({ ...game, id }));
  let running!: Promise<void>;
  act(() => { running = result.current.run([...collections, { ...game, id: "manga", type: "manga" }], vi.fn()); });
  await waitFor(() => expect(gateway.fetchLaunchBoxSpines).toHaveBeenCalledTimes(3));
  expect(result.current).toMatchObject({ processed: 2, total: 5 });
  for (let processed = 1; processed <= 3; processed++) {
    act(() => report({ jobId: job, phase: "game_completed", processed, total: 3, outcome: outcome(collections[processed + 1].id, "skipped") }));
    expect(result.current).toMatchObject({ processed: 2 + processed, total: 5 });
    expect(result.current.processed).toBeLessThanOrEqual(result.current.total);
  }
  await act(async () => {
    finish({ jobId: job, outcomes: collections.slice(2).map(item => outcome(item.id, "skipped")), nextCursor: "e", hasMore: false, cancelled: false });
    await running;
  });
  expect(result.current).toMatchObject({ processed: 5, total: 5, running: false });
});

it("fills information before spines, shows each phase and reports platform fills", async () => {
  const { gateway } = setup();
  let finishInfo!: (result: LaunchBoxSpineBatchResult) => void;
  let reportInfo!: (progress: LaunchBoxSpineProgress) => void;
  let infoJob = "";
  let finishSpines!: (result: LaunchBoxSpineBatchResult) => void;
  let spineJob = "";
  const changed = vi.fn().mockResolvedValue(undefined);
  gateway.fetchLaunchBoxSpines.mockImplementation(async (request, report) => {
    if (request.action === "cancel") throw new Error("unexpected cancel");
    if (request.informationOnly) {
      infoJob = request.jobId; reportInfo = report!;
      return new Promise(resolve => { finishInfo = resolve; });
    }
    spineJob = request.jobId;
    return new Promise(resolve => { finishSpines = resolve; });
  });
  const { result } = renderHook(() => useLaunchBoxSpineBatch(gateway as unknown as LibraryGateway, "information-phase"));
  let running!: Promise<void>;
  act(() => { running = result.current.run([game], changed); });
  await waitFor(() => expect(gateway.fetchLaunchBoxSpines).toHaveBeenCalledOnce());
  act(() => reportInfo({ jobId: infoJob, phase: "information", processed: 12, total: 178, outcome: null }));
  expect(result.current).toMatchObject({ phase: "정보", processed: 12, total: 178 });
  await act(async () => finishInfo({ jobId: infoJob, outcomes: [{ ...outcome("a", "skipped"), platformsFilled: 1 }], platformsFilled: 1, cancelled: false, nextCursor: "a", hasMore: false }));
  await waitFor(() => expect(gateway.fetchLaunchBoxSpines).toHaveBeenCalledTimes(2));
  expect(result.current).toMatchObject({ phase: "책등", processed: 0, total: 1 });
  expect(changed).toHaveBeenCalledOnce();
  await act(async () => { finishSpines({ jobId: spineJob, outcomes: [outcome("a", "no_match")], cancelled: false, nextCursor: "a", hasMore: false }); await running; });
  expect(result.current.message).toContain("플랫폼 1개 채움");
});

it("cancels the spine phase after information completes", async () => {
  const { gateway } = setup();
  let finish!: (result: LaunchBoxSpineBatchResult) => void;
  let job = "";
  gateway.fetchLaunchBoxSpines.mockImplementation(async request => {
    if (request.action === "cancel") return { jobId: request.jobId, outcomes: [], cancelled: true, nextCursor: null, hasMore: false };
    if (request.informationOnly) return { jobId: request.jobId, outcomes: [], cancelled: false, nextCursor: null, hasMore: false };
    job = request.jobId; return new Promise(resolve => { finish = resolve; });
  });
  const { result } = renderHook(() => useLaunchBoxSpineBatch(gateway as unknown as LibraryGateway, "spine-cancel"));
  let running!: Promise<void>;
  act(() => { running = result.current.run([game], vi.fn()); });
  await waitFor(() => expect(gateway.fetchLaunchBoxSpines).toHaveBeenCalledTimes(2));
  await act(async () => { await result.current.cancel(); });
  expect(gateway.fetchLaunchBoxSpines).toHaveBeenLastCalledWith({ action: "cancel", jobId: job });
  await act(async () => { finish({ jobId: job, outcomes: [], cancelled: true, nextCursor: null, hasMore: true }); await running; });
  expect(gateway.fetchLaunchBoxSpines).toHaveBeenCalledTimes(3);
});

it("uses the owned device for light-case material and spine printing", async () => {
  const gateway = { listCollectionShelfCases: vi.fn().mockResolvedValue([{ collectionId: "a", ownedPlatform: "PS5", spineArtworkId: null }]) } as unknown as LibraryGateway;
  const { container } = render(<LibraryProvider gateway={gateway}><CollectionShelfCase collection={{ ...game, platforms: "PC · Nintendo Switch 2" }} front={null} privacy={false} active selected={false} /></LibraryProvider>);
  await waitFor(() => expect(container.querySelector('[data-spine-template="ps5"]')).not.toBeNull());
});

it("reads a whole shelf of cases in one call and prints a remounted case at once", async () => {
  const read = vi.fn().mockResolvedValue([{ collectionId: "g2", ownedPlatform: "PS5", spineArtworkId: null }]);
  const gateway = { listCollectionShelfCases: read } as unknown as LibraryGateway;
  const ids = Array.from({ length: 40 }, (_, index) => `g${index}`);
  const shelf = () => <LibraryProvider gateway={gateway}>{ids.map(id => <CollectionShelfCase key={id} collection={{ ...game, id, platforms: "Nintendo Switch 2" }} front={null} privacy={false} active selected={false} />)}</LibraryProvider>;
  const first = render(shelf());
  await waitFor(() => expect(first.container.querySelector('[data-spine-template="ps5"]')).not.toBeNull());
  // Performance lock: one command for the list, never one (or two) per case.
  expect(read).toHaveBeenCalledOnce();
  expect(read.mock.calls[0][0]).toEqual(ids);
  first.unmount();
  const again = render(shelf());
  expect(again.container.querySelector('[data-spine-template="ps5"]')).not.toBeNull();
  await waitFor(() => expect(read).toHaveBeenCalledTimes(2));
});

