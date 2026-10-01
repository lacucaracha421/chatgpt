vi.mock("./physical/collectibleRuntime", async importOriginal => ({ ...await importOriginal<typeof import("./physical/collectibleRuntime")>(), acquireCover: (_request: unknown, callback: (value: null) => void) => { callback(null); return () => undefined; } }));
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { LibraryProvider } from "../library/LibraryContext";
import type { CollectionSummary, LibraryGateway, LaunchBoxSpineBatchResult, LaunchBoxSpineProgress, LaunchBoxSpineOutcome } from "../library/types";
import { CollectionBrowser } from "./CollectionBrowser";
import { createDefaultCollectionLibraryState } from "./collectionLibrary";
import { requestMissingGameSpine } from "./launchBoxSpines";
import { CollectionShelfCase } from "./case/LightCase";
afterEach(cleanup);
const game = { id: "a", name: "게임", type: "game", updatedAt: "r", platforms: "Switch 2", unreadReleaseCount: 0, createdAt: "r", showcase: false } as CollectionSummary;
const outcome = (id: string, status: LaunchBoxSpineOutcome["status"]): LaunchBoxSpineOutcome => ({ collectionId: id, status, reason: "", artworkId: null, databaseId: null, platform: null, fileName: null, region: null, cached: false });
function setup() {
  const gateway = { listCollectionWorkArtworks: vi.fn().mockResolvedValue([]), fetchLaunchBoxSpines: vi.fn<NonNullable<LibraryGateway["fetchLaunchBoxSpines"]>>() };
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
    if (!request.afterCollectionId) return { jobId: request.jobId, outcomes: [outcome("a", "matched")], nextCursor: "a", hasMore: true, cancelled: false };
    job = request.jobId; report = progress!;
    return new Promise(resolve => { finish = resolve; });
  });
  render(<Browser />); const user = await start();
  await waitFor(() => expect(gateway.fetchLaunchBoxSpines).toHaveBeenCalledTimes(2));
  expect(gateway.fetchLaunchBoxSpines.mock.calls[0][0]).toMatchObject({ action: "run", limit: 50 });
  expect(gateway.fetchLaunchBoxSpines.mock.calls[1][0]).toMatchObject({ action: "run", limit: 50, afterCollectionId: "a" });
  expect(gateway.listCollectionWorkArtworks.mock.calls.map(args => args[0])).not.toContain("manga");
  act(() => report({ jobId: job, phase: "game_completed", processed: 1, total: 2, outcome: outcome("b", "no_match") }));
  expect(screen.getByText("책등 받는 중 2 / 5")).toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "작품 관리" }));
  expect(screen.getByRole("menuitem", { name: "책등 받기" })).toHaveAttribute("aria-disabled", "true");
  await user.keyboard("{Escape}");
  await act(async () => finish({ jobId: job, outcomes: [outcome("b", "no_match"), outcome("c", "ambiguous"), outcome("d", "failed"), outcome("e", "skipped")], nextCursor: "e", hasMore: false, cancelled: false }));
  expect(screen.getByText("책등 1개 받음 · 못 찾음 1 · 애매함 1 · 실패 1")).toBeInTheDocument();
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
  expect(screen.getByText("책등 1개 받음 · 못 찾음 0 · 애매함 0 · 실패 0")).toBeInTheDocument();
});
it("uses the shared toast for command errors", async () => {
  const { gateway, Browser } = setup(); gateway.fetchLaunchBoxSpines.mockRejectedValue(new Error("요청 실패"));
  render(<Browser />); await start();
  expect(await screen.findByRole("alert")).toHaveClass("ui-toast");
  expect(screen.queryByRole("dialog")).toBeNull();
});
it("refreshes the matched light case without changing the collection timestamp", async () => {
  const gateway = { listCollectionWorkArtworks: vi.fn().mockResolvedValue([]), fetchLaunchBoxSpine: vi.fn().mockResolvedValue(outcome("a", "matched")) } as unknown as LibraryGateway;
  const { container } = render(<LibraryProvider gateway={gateway}><CollectionShelfCase collection={game} front={null} privacy={false} active selected={false} /></LibraryProvider>);
  await waitFor(() => expect(gateway.listCollectionWorkArtworks).toHaveBeenCalledOnce());
  vi.mocked(gateway.listCollectionWorkArtworks).mockResolvedValue([{ id: "spine", kind: "spine", selected: true }]);
  await act(async () => { await requestMissingGameSpine(gateway, "", game, []); });
  await waitFor(() => expect(gateway.listCollectionWorkArtworks).toHaveBeenCalledTimes(2));
  const image = container.querySelector<HTMLImageElement>('img[src*="spine"]')!;
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
