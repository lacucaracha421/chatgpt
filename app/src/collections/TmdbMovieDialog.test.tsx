import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LibraryProvider } from "../library/LibraryContext";
import type { CollectionSummary, LibraryGateway, TmdbMoviePreview, TmdbSearchResult } from "../library/types";
import { TmdbMovieDialog } from "./TmdbMovieDialog";

afterEach(cleanup);

const searchResults: TmdbSearchResult[] = [
  { movieId: 10494, title: "기생충", originalTitle: "Parasite", releaseDate: "2019-05-30", posterPath: "/search-poster.jpg" },
  { movieId: 2, title: "두 번째 영화", originalTitle: "Second Movie", releaseDate: null, posterPath: null },
];

const preview: TmdbMoviePreview = {
  movieId: 10494,
  proposedTitle: "기생충",
  originalTitle: "Parasite",
  releaseDate: "2019-05-30",
  runtimeMinutes: 132,
  director: "봉준호",
  productionCompany: "바른손이앤에이",
  genres: "드라마, 스릴러",
  overview: "서로 다른 두 가족의 이야기",
  externalScore: 87,
  posters: [
    { filePath: "/poster.jpg", width: 500, height: 750 },
    { filePath: "/poster-2.jpg", width: 500, height: 750 },
  ],
  backdrops: [{ filePath: "/backdrop.jpg", width: 1280, height: 720 }],
};

const collection = { id: "movie-1", name: "기생충", type: "movie" } as CollectionSummary;

function makeGateway(overrides: Partial<LibraryGateway> = {}) {
  return {
    searchTmdbMovies: vi.fn().mockResolvedValue(searchResults),
    previewTmdbMovie: vi.fn().mockResolvedValue(preview),
    applyTmdbMovie: vi.fn().mockResolvedValue(collection),
    ...overrides,
  } as unknown as LibraryGateway;
}

function renderDialog(
  gateway: LibraryGateway = makeGateway(),
  target: { kind: "new" } | { kind: "existing"; collectionId: string } = { kind: "new" },
  onOpenSettings = vi.fn(),
) {
  const onApplied = vi.fn().mockResolvedValue(undefined);
  const onClose = vi.fn();
  const view = render(
    <LibraryProvider gateway={gateway}>
      <TmdbMovieDialog open target={target} onClose={onClose} onOpenSettings={onOpenSettings} onApplied={onApplied} />
    </LibraryProvider>,
  );
  return { onApplied, onClose, onOpenSettings, view };
}

async function reachPreview(user: ReturnType<typeof userEvent.setup>) {
  await user.type(screen.getByRole("searchbox", { name: "영화 검색" }), "  기생충  ");
  await user.click(screen.getByRole("button", { name: "검색" }));
  const result = await screen.findByRole("button", { name: /기생충/ });
  await user.click(result);
  await user.click(screen.getByRole("button", { name: "다음" }));
  await screen.findByRole("heading", { name: "포스터 선택" });
  return result;
}

describe("TmdbMovieDialog", () => {
  it("searches, keeps artwork unselected, applies one poster and no backdrop", async () => {
    const user = userEvent.setup();
    const gateway = makeGateway();
    const { onApplied, onClose } = renderDialog(gateway);

    await reachPreview(user);
    expect(gateway.searchTmdbMovies).toHaveBeenCalledWith("기생충");
    expect(gateway.previewTmdbMovie).toHaveBeenCalledWith(10494);
    expect(screen.getByText("Parasite")).toBeVisible();
    expect(screen.getAllByRole("radio").some((radio) => (radio as HTMLInputElement).checked)).toBe(false);

    await user.click(screen.getByRole("radio", { name: /poster\.jpg/ }));
    await user.click(screen.getByRole("button", { name: "배경 없이 가져오기" }));
    await user.click(screen.getByRole("button", { name: "가져오기" }));

    await waitFor(() => expect(gateway.applyTmdbMovie).toHaveBeenCalledWith({
      target: { kind: "new" },
      movieId: 10494,
      posterPath: "/poster.jpg",
      backdropPath: null,
    }));
    expect(onClose).toHaveBeenCalledOnce();
    expect(onApplied).toHaveBeenCalledWith(collection);
  });

  it("does not block apply when poster and backdrop candidates are missing", async () => {
    const user = userEvent.setup();
    const gateway = makeGateway({
      previewTmdbMovie: vi.fn().mockResolvedValue({ ...preview, posters: [], backdrops: [] }),
    });
    renderDialog(gateway);

    await reachPreview(user);
    const apply = screen.getByRole("button", { name: "가져오기" });
    expect(apply).toBeEnabled();
    await user.click(apply);

    await waitFor(() => expect(gateway.applyTmdbMovie).toHaveBeenCalledWith({
      target: { kind: "new" }, movieId: 10494, posterPath: null, backdropPath: null,
    }));
  });

  it("preserves search and results when going back from preview", async () => {
    const user = userEvent.setup();
    renderDialog();

    const result = await reachPreview(user);
    await user.click(screen.getByRole("button", { name: "뒤로" }));

    expect(screen.getByRole("searchbox", { name: "영화 검색" })).toHaveValue("  기생충  ");
    expect(result).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByText("Parasite")).toBeVisible();
  });

  it("ignores a stale search completion after close and reopen", async () => {
    const user = userEvent.setup();
    let resolveFirst!: (results: TmdbSearchResult[]) => void;
    let resolveSecond!: (results: TmdbSearchResult[]) => void;
    const gateway = makeGateway({
      searchTmdbMovies: vi.fn()
        .mockImplementationOnce(() => new Promise<TmdbSearchResult[]>((resolve) => { resolveFirst = resolve; }))
        .mockImplementationOnce(() => new Promise<TmdbSearchResult[]>((resolve) => { resolveSecond = resolve; })),
    });
    const rendered = renderDialog(gateway);

    await user.type(screen.getByRole("searchbox", { name: "영화 검색" }), "첫 검색");
    await user.click(screen.getByRole("button", { name: "검색" }));
    rendered.view.rerender(
      <LibraryProvider gateway={gateway}>
        <TmdbMovieDialog open={false} target={{ kind: "new" }} onClose={vi.fn()} onOpenSettings={vi.fn()} onApplied={vi.fn()} />
      </LibraryProvider>,
    );
    rendered.view.rerender(
      <LibraryProvider gateway={gateway}>
        <TmdbMovieDialog open target={{ kind: "new" }} onClose={vi.fn()} onOpenSettings={vi.fn()} onApplied={vi.fn()} />
      </LibraryProvider>,
    );
    await user.type(screen.getByRole("searchbox", { name: "영화 검색" }), "두 번째 검색");
    await user.click(screen.getByRole("button", { name: "검색" }));

    resolveFirst([{ ...searchResults[0], title: "오래된 결과" }]);
    await Promise.resolve();
    expect(screen.queryByText("오래된 결과")).not.toBeInTheDocument();
    resolveSecond([{ ...searchResults[0], title: "새 결과" }]);
    expect(await screen.findByText("새 결과")).toBeVisible();
  });

  it("opens Settings without exposing a missing-credential response body", async () => {
    const user = userEvent.setup();
    const onOpenSettings = vi.fn();
    const gateway = makeGateway({ searchTmdbMovies: vi.fn().mockRejectedValue({ code: "tmdb_credential_not_configured", message: "secret body" }) });
    renderDialog(gateway, { kind: "new" }, onOpenSettings);

    await user.type(screen.getByRole("searchbox", { name: "영화 검색" }), "기생충");
    await user.click(screen.getByRole("button", { name: "검색" }));
    expect(await screen.findByRole("button", { name: "TMDB 설정 열기" })).toBeVisible();
    expect(screen.getByRole("alert")).not.toHaveTextContent("secret body");
    await user.click(screen.getByRole("button", { name: "TMDB 설정 열기" }));
    expect(onOpenSettings).toHaveBeenCalledOnce();
  });

  it("uses an existing collection target when applying", async () => {
    const user = userEvent.setup();
    const gateway = makeGateway();
    renderDialog(gateway, { kind: "existing", collectionId: "movie-9" });

    await reachPreview(user);
    await user.click(screen.getByRole("radio", { name: /poster\.jpg/ }));
    await user.click(screen.getByRole("button", { name: "배경 없이 가져오기" }));
    await user.click(screen.getByRole("button", { name: "저장" }));

    await waitFor(() => expect(gateway.applyTmdbMovie).toHaveBeenCalledWith({
      target: { kind: "existing", collectionId: "movie-9" },
      movieId: 10494,
      posterPath: "/poster.jpg",
      backdropPath: null,
    }));
  });
});
