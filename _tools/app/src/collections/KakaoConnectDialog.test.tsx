import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LibraryProvider } from "../library/LibraryContext";
import type { KakaoSeriesCandidate, LibraryGateway } from "../library/types";
import { KakaoConnectDialog } from "./KakaoConnectDialog";

afterEach(cleanup);

const candidates: KakaoSeriesCandidate[] = [{
  anchorItemId: "item-1",
  groupFingerprint: "fingerprint-a",
  title: "던전밥",
  author: "쿠이 료코",
  publisher: "소미미디어",
  volumes: [
    { volumeNumber: 1, providerItemId: "item-1", title: "던전밥 1권", publicationDate: "2015-07-01", isbn13: "9781" },
    { volumeNumber: 3, providerItemId: "item-3", title: "던전밥 3권", publicationDate: null, isbn13: null },
  ],
  ignoredCount: 2,
}];

function renderDialog(overrides: Partial<LibraryGateway> = {}) {
  const gateway = {
    searchKakao: vi.fn().mockResolvedValue(candidates),
    applyKakao: vi.fn().mockResolvedValue({ added: 2, updated: 0, unchanged: 0, ignored: 2 }),
    ...overrides,
  } as unknown as LibraryGateway;
  const onClose = vi.fn();
  const onApplied = vi.fn().mockResolvedValue(undefined);
  render(
    <LibraryProvider gateway={gateway}>
      <KakaoConnectDialog
        open
        collectionId="collection-1"
        initialQuery="던전밥"
        onClose={onClose}
        onApplied={onApplied}
      />
    </LibraryProvider>,
  );
  return { gateway, onClose, onApplied };
}

describe("KakaoConnectDialog", () => {
  it("searches only on submit and shows text-only grouped volume details", async () => {
    const user = userEvent.setup();
    const { gateway } = renderDialog();

    expect(screen.getByRole("searchbox", { name: "카카오 작품 검색" })).toHaveValue("던전밥");
    expect(gateway.searchKakao).not.toHaveBeenCalled();
    expect(screen.queryByRole("img")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "검색" }));

    expect(gateway.searchKakao).toHaveBeenCalledWith("던전밥");
    const result = await screen.findByRole("button", { name: /던전밥.*쿠이 료코.*소미미디어.*1–3권.*2권/ });
    expect(screen.queryByRole("img")).not.toBeInTheDocument();
    await user.click(result);
    expect(screen.getByText("던전밥 1권")).toBeInTheDocument();
    expect(screen.getByText("던전밥 3권")).toBeInTheDocument();
    expect(screen.getByText("제외된 상품 2개")).toBeInTheDocument();
  });

  it("rejects a one-character query locally and applies exactly the selected identity", async () => {
    const user = userEvent.setup();
    const { gateway, onApplied, onClose } = renderDialog();
    const searchbox = screen.getByRole("searchbox", { name: "카카오 작품 검색" });
    await user.clear(searchbox);
    await user.type(searchbox, " 가 ");
    await user.click(screen.getByRole("button", { name: "검색" }));
    expect(screen.getByRole("alert")).toHaveTextContent("두 글자 이상");
    expect(gateway.searchKakao).not.toHaveBeenCalled();

    await user.clear(searchbox);
    await user.type(searchbox, " 던전밥 ");
    await user.click(screen.getByRole("button", { name: "검색" }));
    await user.click(await screen.findByRole("button", { name: /던전밥.*쿠이 료코/ }));
    await user.click(screen.getByRole("button", { name: "연결" }));

    expect(gateway.applyKakao).toHaveBeenCalledWith({
      collectionId: "collection-1",
      query: "던전밥",
      groups: [{ anchorItemId: "item-1", groupFingerprint: "fingerprint-a" }],
    });
    await waitFor(() => expect(onApplied).toHaveBeenCalledWith({ added: 2, updated: 0, unchanged: 0, ignored: 2 }));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("checks several groups Kakao split from one series and applies them together", async () => {
    const user = userEvent.setup();
    const split: KakaoSeriesCandidate[] = [
      {
        anchorItemId: "isbn13:0010", groupFingerprint: "fingerprint-somi", title: "찍히지 않습니다",
        author: "코노시마 루카", publisher: "소미미디어", ignoredCount: 0,
        volumes: [1, 2, 3, 4, 5, 6].map((n) => ({ volumeNumber: n, providerItemId: `isbn13:00${n}0`, title: `찍히지 않습니다 ${n}`, publicationDate: null, isbn13: null })),
      },
      {
        anchorItemId: "isbn13:1150", groupFingerprint: "fingerprint-s", title: "찍히지 않습니다",
        author: "코노시마 루카", publisher: "S코믹스", ignoredCount: 1,
        volumes: [{ volumeNumber: 7, providerItemId: "isbn13:1150", title: "찍히지 않습니다 7", publicationDate: "2026-07-22", isbn13: "1150" }],
      },
    ];
    const { gateway } = renderDialog({ searchKakao: vi.fn().mockResolvedValue(split) });
    await user.click(screen.getByRole("button", { name: "검색" }));

    // A row click picks only that group.
    await user.click(await screen.findByRole("button", { name: /S코믹스/ }));
    expect(screen.getByRole("checkbox", { name: "찍히지 않습니다 7권 함께 연결" })).toBeChecked();
    expect(screen.getByRole("checkbox", { name: "찍히지 않습니다 1–6권 함께 연결" })).not.toBeChecked();
    expect(screen.getByRole("button", { name: "연결" })).toBeEnabled();

    // The checkbox adds the earlier volumes' group; both previews and the count show.
    await user.click(screen.getByRole("checkbox", { name: "찍히지 않습니다 1–6권 함께 연결" }));
    expect(screen.getByText("찍히지 않습니다 1")).toBeInTheDocument();
    expect(screen.getByText("찍히지 않습니다 7")).toBeInTheDocument();
    expect(screen.getByText(/시리즈 2개를 함께 연결합니다/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "2개 연결" }));

    expect(gateway.applyKakao).toHaveBeenCalledWith({
      collectionId: "collection-1",
      query: "던전밥",
      groups: [
        { anchorItemId: "isbn13:0010", groupFingerprint: "fingerprint-somi" },
        { anchorItemId: "isbn13:1150", groupFingerprint: "fingerprint-s" },
      ],
    });
  });

  it("unchecking every group disables connect", async () => {
    const user = userEvent.setup();
    renderDialog();
    await user.click(screen.getByRole("button", { name: "검색" }));
    const checkbox = await screen.findByRole("checkbox", { name: "던전밥 1–3권 함께 연결" });
    await user.click(checkbox);
    expect(screen.getByRole("button", { name: "연결" })).toBeEnabled();
    await user.click(checkbox);
    expect(screen.getByRole("button", { name: "연결" })).toBeDisabled();
    expect(screen.getByText("검색 결과에서 연결할 시리즈를 선택하세요.")).toBeInTheDocument();
  });

  it("keeps errors and pending requests inside the dialog", async () => {
    const user = userEvent.setup();
    let resolveSearch!: (value: KakaoSeriesCandidate[]) => void;
    const pending = new Promise<KakaoSeriesCandidate[]>((resolve) => { resolveSearch = resolve; });
    const { gateway, onClose } = renderDialog({ searchKakao: vi.fn().mockReturnValue(pending) });

    await user.click(screen.getByRole("button", { name: "검색" }));
    expect(screen.getByRole("button", { name: "검색 중…" })).toBeDisabled();
    await user.keyboard("{Escape}");
    expect(onClose).not.toHaveBeenCalled();
    resolveSearch([]);
    expect(await screen.findByText("검색 결과가 없습니다.")).toBeInTheDocument();

    vi.mocked(gateway.searchKakao).mockRejectedValueOnce(new Error("검색 실패"));
    await user.click(screen.getByRole("button", { name: "검색" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("검색 실패");
  });
});
