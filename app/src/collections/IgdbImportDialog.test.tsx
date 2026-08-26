import { cleanup, render, screen, waitFor } from "@testing-library/react";
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
});
