import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LibraryProvider } from "../library/LibraryContext";
import type { CollectionSummary, IgdbGamePreview, IgdbSearchResult, LibraryGateway } from "../library/types";
import { IgdbImportDialog } from "./IgdbImportDialog";

afterEach(cleanup);

const result: IgdbSearchResult = {
  gameId: 17,
  title: "Astral Chain",
  developer: "PlatinumGames",
  releaseDate: "2019-08-30",
  cover: { imageId: "co-1", width: 264, height: 374 },
};

const preview: IgdbGamePreview = {
  gameId: 17,
  proposedTitle: "Astral Chain",
  developer: "PlatinumGames",
  publisher: "Nintendo",
  releaseDate: "2019-08-30",
  platforms: ["Nintendo Switch"],
  genres: ["Action"],
  overview: "A fast action game.",
  covers: [
    { imageId: "co-1", width: 264, height: 374 },
    { imageId: "co-2", width: 264, height: 374 },
  ],
  artworks: [
    { imageId: "art-1", width: 1080, height: 608 },
    { imageId: "art-2", width: 1080, height: 608 },
  ],
  screenshots: [{ imageId: "ss-1", width: 1920, height: 1080 }],
};

const collection = { id: "collection-1", name: "Astral Chain", type: "game" } as CollectionSummary;

function makeGateway(overrides: Partial<LibraryGateway> = {}) {
  return {
    searchIgdbGames: vi.fn().mockResolvedValue([result]),
    previewIgdbGame: vi.fn().mockResolvedValue(preview),
    applyIgdbGame: vi.fn().mockResolvedValue(collection),
    getIgdbConnection: vi.fn().mockResolvedValue({ gameId: 17, lastSyncedAt: null }),
    replaceIgdbGameArtwork: vi.fn().mockResolvedValue(collection),
    ...overrides,
  } as unknown as LibraryGateway;
}

function renderDialog(gateway: LibraryGateway = makeGateway(), target: { kind: "new" } | { kind: "existing"; collectionId: string } = { kind: "new" }, onOpenSettings = vi.fn()) {
  const onApplied = vi.fn().mockResolvedValue(undefined);
  const onClose = vi.fn();
  render(
    <LibraryProvider gateway={gateway}>
      <IgdbImportDialog open target={target} onClose={onClose} onApplied={onApplied} onOpenSettings={onOpenSettings} />
    </LibraryProvider>,
  );
  return { onApplied, onClose, onOpenSettings };
}

describe("IgdbImportDialog", () => {
  it("searches, previews on Next, keeps artwork unselected, and applies hero-none", async () => {
    const user = userEvent.setup();
    const gateway = makeGateway();
    const { onApplied } = renderDialog(gateway);

    await user.type(screen.getByRole("searchbox", { name: "게임 검색" }), " astral chain ");
    await user.click(screen.getByRole("button", { name: "검색" }));
    expect(gateway.searchIgdbGames).toHaveBeenCalledWith("astral chain");
    await user.click(await screen.findByRole("button", { name: /Astral Chain/ }));
    expect(gateway.previewIgdbGame).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "다음" }));
    await waitFor(() => expect(gateway.previewIgdbGame).toHaveBeenCalledWith(17));

    expect(screen.getByRole("heading", { name: "표지 선택" })).toBeInTheDocument();
    expect(screen.getAllByRole("radio").some((radio) => (radio as HTMLInputElement).checked)).toBe(false);
    await user.click(screen.getByRole("radio", { name: /co-1/ }));
    await user.click(screen.getByRole("button", { name: "다음" }));
    expect(screen.getByRole("heading", { name: "대표 이미지 선택" })).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: /art-1/ })).toBeInTheDocument();
    expect(screen.queryByRole("radio", { name: /ss-1/ })).not.toBeInTheDocument();
    expect(screen.getAllByRole("radio").some((radio) => (radio as HTMLInputElement).checked)).toBe(false);
    await user.click(screen.getByRole("button", { name: "hero 없이 가져오기" }));
    await user.click(screen.getByRole("button", { name: "가져오기" }));

    await waitFor(() => expect(gateway.applyIgdbGame).toHaveBeenCalledWith({ gameId: 17, coverImageId: "co-1", heroImageId: null }));
    expect(onApplied).toHaveBeenCalledWith(collection);
  });

  it("uses screenshots only when artworks are empty and allows a no-cover advance", async () => {
    const user = userEvent.setup();
    const gateway = makeGateway({
      previewIgdbGame: vi.fn().mockResolvedValue({ ...preview, covers: [], artworks: [] }),
    });
    renderDialog(gateway);
    await user.type(screen.getByRole("searchbox", { name: "게임 검색" }), "astral");
    await user.click(screen.getByRole("button", { name: "검색" }));
    await user.click(await screen.findByRole("button", { name: /Astral Chain/ }));
    await user.click(screen.getByRole("button", { name: "다음" }));
    expect(await screen.findByRole("heading", { name: "표지 선택" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "다음" })).toBeEnabled();
    await user.click(screen.getByRole("button", { name: "다음" }));
    expect(screen.getByRole("radio", { name: /ss-1/ })).toBeInTheDocument();
  });

  it("restores the exact search snapshot when going back from cover", async () => {
    const user = userEvent.setup();
    const gateway = makeGateway();
    renderDialog(gateway);
    const search = screen.getByRole("searchbox", { name: "게임 검색" });
    await user.type(search, " exact query ");
    await user.click(screen.getByRole("button", { name: "검색" }));
    const resultButton = await screen.findByRole("button", { name: /Astral Chain/ });
    await user.click(resultButton);
    await user.click(screen.getByRole("button", { name: "다음" }));
    await screen.findByRole("heading", { name: "표지 선택" });
    await user.click(screen.getByRole("button", { name: "뒤로" }));

    expect(screen.getByRole("searchbox", { name: "게임 검색" })).toHaveValue(" exact query ");
    expect(screen.getByRole("button", { name: /Astral Chain/ })).toHaveAttribute("aria-pressed", "true");
  });

  it("preserves search state and opens Settings for missing credentials", async () => {
    const user = userEvent.setup();
    const gateway = makeGateway({ searchIgdbGames: vi.fn().mockRejectedValue({ code: "igdb_credential_not_configured", message: "secret" }) });
    const { onOpenSettings } = renderDialog(gateway);
    const search = screen.getByRole("searchbox", { name: "게임 검색" });
    await user.type(search, "astral");
    await user.click(screen.getByRole("button", { name: "검색" }));
    expect(await screen.findByRole("button", { name: "IGDB 설정 열기" })).toBeInTheDocument();
    expect(search).toHaveValue("astral");
    expect(screen.getByRole("alert")).not.toHaveTextContent("secret");
    await user.click(screen.getByRole("button", { name: "IGDB 설정 열기" }));
    expect(onOpenSettings).toHaveBeenCalledTimes(1);
  });

  it("keeps an existing load failure out of title search and retries the same connection", async () => {
    const user = userEvent.setup();
    const gateway = makeGateway({
      getIgdbConnection: vi.fn()
        .mockRejectedValueOnce(new Error("연결을 불러오지 못했습니다."))
        .mockResolvedValue({ gameId: 17, lastSyncedAt: null }),
    });
    renderDialog(gateway, { kind: "existing", collectionId: "collection-9" });

    expect(await screen.findByRole("alert")).toHaveTextContent("연결을 불러오지 못했습니다.");
    expect(screen.queryByRole("searchbox", { name: "게임 검색" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "다시 시도" }));
    expect(await screen.findByRole("heading", { name: "표지 선택" })).toBeInTheDocument();
    expect(gateway.getIgdbConnection).toHaveBeenCalledTimes(2);
  });

  it("replaces existing artwork with explicit select and clear decisions", async () => {
    const user = userEvent.setup();
    const gateway = makeGateway();
    renderDialog(gateway, { kind: "existing", collectionId: "collection-9" });
    expect(await screen.findByRole("heading", { name: "표지 선택" })).toBeInTheDocument();
    expect(screen.queryByRole("searchbox")).not.toBeInTheDocument();
    await user.click(screen.getByRole("radio", { name: /co-2/ }));
    await user.click(screen.getByRole("button", { name: "다음" }));
    await user.click(screen.getByRole("button", { name: "hero 없이 가져오기" }));
    await user.click(screen.getByRole("button", { name: "저장" }));
    await waitFor(() => expect(gateway.replaceIgdbGameArtwork).toHaveBeenCalledWith({
      collectionId: "collection-9",
      cover: { kind: "select", imageId: "co-2" },
      hero: { kind: "clear" },
    }));
  });

  it("keeps untouched existing artwork", async () => {
    const user = userEvent.setup();
    const gateway = makeGateway();
    renderDialog(gateway, { kind: "existing", collectionId: "collection-9" });
    await screen.findByRole("heading", { name: "표지 선택" });
    await user.click(screen.getByRole("button", { name: "다음" }));
    await user.click(screen.getByRole("button", { name: "저장" }));
    await waitFor(() => expect(gateway.replaceIgdbGameArtwork).toHaveBeenCalledWith({
      collectionId: "collection-9",
      cover: { kind: "keep" },
      hero: { kind: "keep" },
    }));
  });

  it("blocks cancel while apply is busy and closes only after success", async () => {
    const user = userEvent.setup();
    let finishApply!: (value: CollectionSummary) => void;
    const gateway = makeGateway({
      applyIgdbGame: vi.fn().mockReturnValue(new Promise<CollectionSummary>((resolve) => { finishApply = resolve; })),
    });
    const { onClose } = renderDialog(gateway);
    await user.type(screen.getByRole("searchbox", { name: "게임 검색" }), "astral");
    await user.click(screen.getByRole("button", { name: "검색" }));
    await user.click(await screen.findByRole("button", { name: /Astral Chain/ }));
    await user.click(screen.getByRole("button", { name: "다음" }));
    await user.click(screen.getByRole("radio", { name: /co-1/ }));
    await user.click(screen.getByRole("button", { name: "다음" }));
    await user.click(screen.getByRole("button", { name: "hero 없이 가져오기" }));
    await user.click(screen.getByRole("button", { name: "가져오기" }));
    expect(screen.getByRole("button", { name: "취소" })).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "취소" }));
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    expect(onClose).not.toHaveBeenCalled();
    finishApply(collection);
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
  });

  it("closes after the gateway mutation even when onApplied rejects", async () => {
    const user = userEvent.setup();
    const gateway = makeGateway();
    const onApplied = vi.fn().mockRejectedValue(new Error("후속 갱신 실패"));
    const onClose = vi.fn();
    render(
      <LibraryProvider gateway={gateway}>
        <IgdbImportDialog
          open
          target={{ kind: "existing", collectionId: "collection-9" }}
          onClose={onClose}
          onApplied={onApplied}
          onOpenSettings={vi.fn()}
        />
      </LibraryProvider>,
    );

    await screen.findByRole("heading", { name: "표지 선택" });
    await user.click(screen.getByRole("button", { name: "다음" }));
    await screen.findByRole("heading", { name: "대표 이미지 선택" });
    await user.click(screen.getByRole("button", { name: "저장" }));

    await waitFor(() => expect(gateway.replaceIgdbGameArtwork).toHaveBeenCalledOnce());
    expect(onApplied).toHaveBeenCalledWith(collection);
    expect(onClose).toHaveBeenCalledOnce();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("ignores a retry completion after the existing dialog closes and reopens", async () => {
    const user = userEvent.setup();
    let resolveRetryPreview!: (value: IgdbGamePreview) => void;
    let resolveFreshPreview!: (value: IgdbGamePreview) => void;
    const connection = { gameId: 17, lastSyncedAt: null };
    const gateway = makeGateway({
      getIgdbConnection: vi.fn()
        .mockRejectedValueOnce(new Error("첫 로드 실패"))
        .mockResolvedValue(connection),
      previewIgdbGame: vi.fn()
        .mockImplementationOnce(() => new Promise<IgdbGamePreview>((resolve) => { resolveRetryPreview = resolve; }))
        .mockImplementationOnce(() => new Promise<IgdbGamePreview>((resolve) => { resolveFreshPreview = resolve; })),
    });
    const view = render(
      <LibraryProvider gateway={gateway}>
        <IgdbImportDialog
          open
          target={{ kind: "existing", collectionId: "collection-9" }}
          onClose={vi.fn()}
          onApplied={vi.fn()}
          onOpenSettings={vi.fn()}
        />
      </LibraryProvider>,
    );

    await screen.findByRole("alert");
    await user.click(screen.getByRole("button", { name: "다시 시도" }));
    await waitFor(() => expect(gateway.previewIgdbGame).toHaveBeenCalledTimes(1));

    view.rerender(
      <LibraryProvider gateway={gateway}>
        <IgdbImportDialog
          open={false}
          target={{ kind: "existing", collectionId: "collection-9" }}
          onClose={vi.fn()}
          onApplied={vi.fn()}
          onOpenSettings={vi.fn()}
        />
      </LibraryProvider>,
    );
    view.rerender(
      <LibraryProvider gateway={gateway}>
        <IgdbImportDialog
          open
          target={{ kind: "existing", collectionId: "collection-9" }}
          onClose={vi.fn()}
          onApplied={vi.fn()}
          onOpenSettings={vi.fn()}
        />
      </LibraryProvider>,
    );
    await waitFor(() => expect(gateway.previewIgdbGame).toHaveBeenCalledTimes(2));

    resolveRetryPreview(preview);
    expect(await screen.findByRole("status", { name: "IGDB 게임 정보 불러오는 중" })).toBeInTheDocument();
    resolveFreshPreview(preview);
    expect(await screen.findByRole("heading", { name: "표지 선택" })).toBeInTheDocument();
  });
});
