import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
// @ts-ignore Vitest runs in Node, but this frontend project intentionally omits Node typings.
import { readFileSync } from "node:fs";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LibraryProvider } from "../library/LibraryContext";
import type { AssetPage, AssetSort, AssetView, ClassificationEntry, LibraryGateway } from "../library/types";
import { AssetBrowser, type AssetBrowserStatus } from "./AssetBrowser";
const styles = readFileSync("src/styles/global.css", "utf8");

const classifications: ClassificationEntry[] = [];

afterEach(cleanup);
beforeEach(() => Object.defineProperties(HTMLElement.prototype, {
  offsetWidth: { configurable: true, get: () => 900 },
  clientWidth: { configurable: true, get: () => 840 },
  offsetHeight: { configurable: true, get: () => 600 },
  clientHeight: { configurable: true, get: () => 600 },
}));
beforeEach(() => Object.defineProperties(HTMLDialogElement.prototype, {
  showModal: { configurable: true, value(this: HTMLDialogElement) { this.setAttribute("open", ""); this.querySelector<HTMLButtonElement>(".ui-dialog__actions button")?.focus(); } },
  close: { configurable: true, value(this: HTMLDialogElement) { this.removeAttribute("open"); } },
}));

describe("AssetBrowser", () => {
  it.each<[string, AssetView, AssetSort, Partial<Record<string, unknown>>]>([
    ["classification", { kind: "classification", classificationId: "tag" }, "oldest", { classificationId: "tag", directOnly: false, favoriteOnly: false, unclassifiedOnly: false, sort: "oldest" }],
    ["unsorted", { kind: "unsorted" }, "newest", { classificationId: null, directOnly: false, favoriteOnly: false, unclassifiedOnly: true, sort: "newest" }],
    ["favorites", { kind: "favorites" }, "favorites", { classificationId: null, directOnly: false, favoriteOnly: true, unclassifiedOnly: false, sort: "favorites" }],
    ["recent", { kind: "recent" }, "oldest", { classificationId: null, directOnly: false, favoriteOnly: false, unclassifiedOnly: false, sort: "newest" }],
  ])("maps the %s view to its first-page query", async (_name, view, sort, expected) => {
    const gateway = createGateway();

    render(
      <LibraryProvider gateway={gateway}>
        <AssetBrowser
          view={view}
          classifications={classifications}
          sort={sort}
          metadataVisible={false}
          refreshVersion={0}
          onSortChange={vi.fn()}
          onMetadataVisibleChange={vi.fn()}
          onStatusChange={vi.fn()}
        />
      </LibraryProvider>,
    );

    await waitFor(() =>
      expect(gateway.listAssets).toHaveBeenCalledWith({
        ...expected,
        randomPivot: null,
        after: null,
        limit: 100,
      }),
    );
  });

  it("uses one random pivot for first and next pages", async () => {
    const gateway = createGateway({
      items: Array.from({ length: 50 }, (_, index) => asset(index)),
      nextCursor: { token: "next" },
    });

    render(
      <LibraryProvider gateway={gateway}>
        <AssetBrowser
          view={{ kind: "classification", classificationId: null }}
          classifications={classifications}
          sort="random"
          metadataVisible={false}
          refreshVersion={0}
          onSortChange={vi.fn()}
          onMetadataVisibleChange={vi.fn()}
          onStatusChange={vi.fn()}
        />
      </LibraryProvider>,
    );

    await waitFor(() => expect(gateway.listAssets).toHaveBeenCalledTimes(2));
    const [first, next] = vi.mocked(gateway.listAssets).mock.calls;
    expect(first![0].randomPivot).toMatch(/^[\da-f]{32}$/);
    expect(next![0].randomPivot).toBe(first![0].randomPivot);
  });

  it("retains assets and offers a retry when the next page fails", async () => {
    const gateway = createGateway();
    vi.mocked(gateway.listAssets)
      .mockResolvedValueOnce({ items: Array.from({ length: 50 }, (_, index) => asset(index)), nextCursor: { token: "next" } })
      .mockRejectedValueOnce(new Error("next page failed"));

    render(
      <LibraryProvider gateway={gateway}>
        <AssetBrowser
          view={{ kind: "classification", classificationId: null }}
          classifications={classifications}
          sort="newest"
          metadataVisible={false}
          refreshVersion={0}
          onSortChange={vi.fn()}
          onMetadataVisibleChange={vi.fn()}
          onStatusChange={vi.fn()}
        />
      </LibraryProvider>,
    );

    expect(await screen.findByRole("img", { name: "asset-0.png" })).toBeInTheDocument();
    expect(await screen.findByRole("button", { name: "다시 시도" })).toBeInTheDocument();
  });

  it("maps direct-only and every selectable sort", async () => {
    const user = userEvent.setup();
    const gateway = createGateway();
    const { rerender } = renderBrowser(gateway);
    await user.click(await screen.findByRole("checkbox", { name: "이 분류만" }));
    await waitFor(() => expect(gateway.listAssets).toHaveBeenLastCalledWith(expect.objectContaining({ directOnly: true, sort: "newest" })));
    for (const sort of ["oldest", "favorites", "random"] as const) {
      rerender(browserElement(gateway, { sort }));
      await waitFor(() => expect(gateway.listAssets).toHaveBeenLastCalledWith(expect.objectContaining({ sort, randomPivot: sort === "random" ? expect.stringMatching(/^[\da-f]{32}$/) : null })));
    }
  });

  it("replaces the random pivot only when reshuffled", async () => {
    const user = userEvent.setup(); const gateway = createGateway();
    renderBrowser(gateway, { sort: "random" });
    await waitFor(() => expect(gateway.listAssets).toHaveBeenCalled());
    const first = vi.mocked(gateway.listAssets).mock.calls[0]![0].randomPivot;
    await user.click(screen.getByRole("button", { name: "다시 섞기" }));
    await waitFor(() => expect(gateway.listAssets).toHaveBeenCalledTimes(2));
    expect(vi.mocked(gateway.listAssets).mock.calls[1]![0].randomPivot).not.toBe(first);
  });

  it("creates a new pivot after leaving and re-entering random", async () => {
    const gateway = createGateway(); const { rerender } = renderBrowser(gateway, { sort: "random" });
    await waitFor(() => expect(gateway.listAssets).toHaveBeenCalledTimes(1));
    const first = vi.mocked(gateway.listAssets).mock.calls[0]![0].randomPivot;
    rerender(browserElement(gateway, { sort: "oldest" }));
    await waitFor(() => expect(gateway.listAssets).toHaveBeenCalledTimes(2));
    rerender(browserElement(gateway, { sort: "random" }));
    await waitFor(() => expect(gateway.listAssets).toHaveBeenCalledTimes(3));
    expect(vi.mocked(gateway.listAssets).mock.calls[2]![0].randomPivot).not.toBe(first);
  });

  it("keeps the random pivot through an ordinary refresh", async () => {
    const gateway = createGateway(); const { rerender } = renderBrowser(gateway, { sort: "random" });
    await waitFor(() => expect(gateway.listAssets).toHaveBeenCalledTimes(1));
    const first = vi.mocked(gateway.listAssets).mock.calls[0]![0].randomPivot;
    rerender(browserElement(gateway, { sort: "random", refreshVersion: 1 }));
    await waitFor(() => expect(gateway.listAssets).toHaveBeenCalledTimes(2));
    expect(vi.mocked(gateway.listAssets).mock.calls[1]![0].randomPivot).toBe(first);
  });

  it("ignores stale first-page success", async () => {
    let resolveOld!: (page: AssetPage) => void;
    const old = new Promise<AssetPage>((resolve) => { resolveOld = resolve; });
    const gateway = createGateway();
    vi.mocked(gateway.listAssets).mockReturnValueOnce(old).mockResolvedValueOnce({ items: [{ ...asset(1), title: "New" }], nextCursor: null });
    const status = vi.fn();
    const { rerender } = render(browserElement(gateway, { status }));
    rerender(browserElement(gateway, { sort: "oldest", status }));
    expect(await screen.findByRole("button", { name: "New" })).toBeInTheDocument();
    await act(async () => { resolveOld({ items: [{ ...asset(0), title: "Old" }], nextCursor: null }); await old; });
    expect(screen.queryByRole("button", { name: "Old" })).not.toBeInTheDocument();
    expect(status).toHaveBeenLastCalledWith(expect.objectContaining({ loading: false }));
  });

  it("ignores stale first-page failure and finalization", async () => {
    let rejectOld!: (error: Error) => void; let resolveNew!: (page: AssetPage) => void;
    const old = new Promise<AssetPage>((_resolve, reject) => { rejectOld = reject; });
    const next = new Promise<AssetPage>((resolve) => { resolveNew = resolve; });
    const gateway = createGateway(); const status = vi.fn();
    vi.mocked(gateway.listAssets).mockReturnValueOnce(old).mockReturnValueOnce(next);
    const { rerender } = render(browserElement(gateway, { status }));
    rerender(browserElement(gateway, { sort: "oldest", status }));
    await act(async () => { rejectOld(new Error("late failure")); await old.catch(() => undefined); });
    expect(screen.queryByText("late failure")).not.toBeInTheDocument();
    expect(status).toHaveBeenLastCalledWith(expect.objectContaining({ loading: true }));
    await act(async () => { resolveNew({ items: [{ ...asset(1), title: "New" }], nextCursor: null }); await next; });
    expect(await screen.findByRole("button", { name: "New" })).toBeInTheDocument();
  });

  it("retries a failed first page", async () => {
    const user = userEvent.setup(); const gateway = createGateway();
    vi.mocked(gateway.listAssets).mockRejectedValueOnce(new Error("first page failed")).mockResolvedValueOnce({ items: [{ ...asset(0), title: "Recovered" }], nextCursor: null });
    renderBrowser(gateway);
    await user.click(await screen.findByRole("button", { name: "다시 시도" }));
    expect(await screen.findByRole("button", { name: "Recovered" })).toBeInTheDocument();
  });

  it("never loads an old cursor with a newly selected sort", async () => {
    const gateway = createGateway();
    vi.mocked(gateway.listAssets)
      .mockResolvedValueOnce({ items: Array.from({ length: 50 }, (_, index) => asset(index)), nextCursor: { token: "old-cursor" } })
      .mockResolvedValue({ items: [], nextCursor: null });
    const { rerender } = renderBrowser(gateway, { sort: "newest" });
    await screen.findByRole("img", { name: "asset-0.png" });

    rerender(<LibraryProvider gateway={gateway}><AssetBrowser view={{ kind: "classification", classificationId: null }} classifications={classifications} sort="oldest" metadataVisible={false} refreshVersion={0} onSortChange={vi.fn()} onMetadataVisibleChange={vi.fn()} onStatusChange={vi.fn()} /></LibraryProvider>);

    await waitFor(() => expect(gateway.listAssets).toHaveBeenCalledWith(expect.objectContaining({ sort: "oldest", after: null })));
    expect(vi.mocked(gateway.listAssets).mock.calls).not.toContainEqual([expect.objectContaining({ sort: "oldest", after: { token: "old-cursor" } })]);
  });

  it("preserves selection and detail through refresh when the asset remains", async () => {
    const user = userEvent.setup();
    const gateway = createGateway();
    vi.mocked(gateway.listAssets)
      .mockResolvedValueOnce({ items: [{ ...asset(0), title: "Before" }], nextCursor: null })
      .mockResolvedValueOnce({ items: [{ ...asset(0), title: "After" }], nextCursor: null });
    const { rerender } = renderBrowser(gateway);
    const tile = await screen.findByRole("button", { name: "Before" });
    await user.click(tile);
    await user.dblClick(tile);
    expect(screen.getByRole("dialog")).toBeInTheDocument();

    rerender(<LibraryProvider gateway={gateway}><AssetBrowser view={{ kind: "classification", classificationId: null }} classifications={classifications} sort="newest" metadataVisible={false} refreshVersion={1} onSortChange={vi.fn()} onMetadataVisibleChange={vi.fn()} onStatusChange={vi.fn()} /></LibraryProvider>);

    expect(await screen.findByRole("button", { name: "After" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("dialog")).toHaveAccessibleName("After");
  });

  it("clears selection when the refreshed page no longer contains the asset", async () => {
    const user = userEvent.setup(); const gateway = createGateway();
    vi.mocked(gateway.listAssets).mockResolvedValueOnce({ items: [{ ...asset(0), title: "Selected" }], nextCursor: null }).mockResolvedValueOnce({ items: [], nextCursor: null });
    const { rerender } = renderBrowser(gateway); await user.click(await screen.findByRole("button", { name: "Selected" }));
    rerender(browserElement(gateway, { refreshVersion: 1 }));
    expect(await screen.findByRole("heading", { name: "자산이 없습니다" })).toBeInTheDocument();
  });

  it("clears selection when the view changes", async () => {
    const user = userEvent.setup(); const gateway = createGateway();
    vi.mocked(gateway.listAssets).mockResolvedValue({ items: [{ ...asset(0), title: "Selected" }], nextCursor: null });
    const { rerender } = renderBrowser(gateway); await user.click(await screen.findByRole("button", { name: "Selected" }));
    rerender(<LibraryProvider gateway={gateway}><AssetBrowser view={{ kind: "favorites" }} classifications={classifications} sort="newest" metadataVisible={false} refreshVersion={0} onSortChange={vi.fn()} onMetadataVisibleChange={vi.fn()} onStatusChange={vi.fn()} /></LibraryProvider>);
    expect(await screen.findByRole("button", { name: "Selected" })).toHaveAttribute("aria-pressed", "false");
  });

  it("keeps the detail dialog open after a real Enter press", async () => {
    const user = userEvent.setup(); const gateway = createGateway({ items: [{ ...asset(0), title: "열기" }], nextCursor: null });
    renderBrowser(gateway);
    const tile = await screen.findByRole("button", { name: "열기" });
    tile.focus();
    await user.keyboard("{Enter}");
    expect(screen.getByRole("dialog", { name: "열기" })).toBeInTheDocument();
  });

  it("moves the selected asset to trash and refreshes the gallery", async () => {
    const user = userEvent.setup();
    const gateway = createGateway({ items: [{ ...asset(0), title: "Delete me" }], nextCursor: null });
    renderBrowser(gateway);

    await user.click(await screen.findByRole("button", { name: "Delete me" }));
    await user.click(screen.getByRole("button", { name: "휴지통으로 이동" }));

    expect(gateway.trashAsset).toHaveBeenCalledWith("asset-0");
    expect(screen.getByText("휴지통으로 이동했습니다.")).toBeVisible();
  });

  it("keeps the selected asset when moving it to trash fails", async () => {
    const user = userEvent.setup();
    const gateway = createGateway({ items: [{ ...asset(0), title: "Keep me" }], nextCursor: null });
    vi.mocked(gateway.trashAsset).mockRejectedValue(new Error("trash failed"));
    renderBrowser(gateway);

    await user.click(await screen.findByRole("button", { name: "Keep me" }));
    await user.click(screen.getByRole("button", { name: "휴지통으로 이동" }));

    expect(await screen.findByText("trash failed")).toBeVisible();
    expect(screen.getByRole("button", { name: "휴지통으로 이동" })).toBeVisible();
  });

  it("disables trash while pending and preserves a newer selection", async () => {
    let resolveTrash!: () => void;
    const pendingTrash = new Promise<void>((resolve) => { resolveTrash = resolve; });
    const user = userEvent.setup();
    const gateway = createGateway({ items: [{ ...asset(0), title: "First" }, { ...asset(1), title: "Second" }], nextCursor: null });
    vi.mocked(gateway.trashAsset).mockReturnValue(pendingTrash);
    renderBrowser(gateway);

    await user.click(await screen.findByRole("button", { name: "First" }));
    await user.click(screen.getByRole("button", { name: "휴지통으로 이동" }));
    expect(screen.getByRole("button", { name: "휴지통으로 이동" })).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "Second" }));
    await act(async () => { resolveTrash(); await pendingTrash; });

    expect(await screen.findByRole("button", { name: "Second" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "휴지통으로 이동" })).not.toBeDisabled();
  });

  it("uses the constrained workspace styles without horizontal sidebar scrolling", () => {
    expect(styles).toMatch(/\.asset-browser\s*\{[^}]*display:\s*flex;[^}]*min-height:\s*0;/s);
    expect(styles).toMatch(/\.asset-gallery__scroll\s*\{[^}]*flex:\s*1;[^}]*min-height:\s*0;[^}]*overflow:\s*auto;/s);
    expect(styles).not.toMatch(/\.asset-gallery__scroll\s*\{[^}]*height:\s*70vh;/s);
    expect(styles).toMatch(/\.classification-sidebar\s*\{[^}]*overflow-x:\s*hidden;[^}]*overflow-y:\s*auto;/s);
  });
});

function renderBrowser(gateway: LibraryGateway, options: BrowserOptions = {}) {
  return render(browserElement(gateway, options));
}

type BrowserOptions = { sort?: AssetSort; refreshVersion?: number; status?: (status: AssetBrowserStatus) => void };
function browserElement(gateway: LibraryGateway, { sort = "newest", refreshVersion = 0, status = vi.fn() }: BrowserOptions = {}) {
  return <LibraryProvider gateway={gateway}><AssetBrowser view={{ kind: "classification", classificationId: null }} classifications={classifications} sort={sort} metadataVisible={false} refreshVersion={refreshVersion} onSortChange={vi.fn()} onMetadataVisibleChange={vi.fn()} onStatusChange={status} /></LibraryProvider>;
}

function asset(index: number) {
  return {
    id: `asset-${index}`,
    title: null,
    originalName: `asset-${index}.png`,
    byteSize: 1,
    width: 200,
    height: 200,
    collectedAt: "2026-07-30T00:00:00Z",
    favorite: false,
    sourceUrl: null,
  };
}

function createGateway(page: AssetPage = { items: [], nextCursor: null }): LibraryGateway {
  return {
    openLibrary: vi.fn(), currentLibrary: vi.fn(), listClassifications: vi.fn(),
    createClassification: vi.fn(), renameClassification: vi.fn(), moveClassification: vi.fn(),
    deleteClassification: vi.fn(), listAssets: vi.fn().mockResolvedValue(page),
    trashAsset: vi.fn(), restoreAsset: vi.fn(), listTrash: vi.fn(), emptyTrash: vi.fn(),
    getTrashPolicy: vi.fn(), setTrashPolicy: vi.fn(),
    ensureDailyBackup: vi.fn(), listMetadataBackups: vi.fn(),
    restoreMetadataBackup: vi.fn(), purgeExpiredTrash: vi.fn(),
    setAssetFavorite: vi.fn(), setAssetClassifications: vi.fn(),
    getAssetClassifications: vi.fn().mockResolvedValue([]), ingestImage: vi.fn(),
  };
}
