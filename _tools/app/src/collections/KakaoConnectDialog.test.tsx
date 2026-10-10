import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LibraryProvider } from "../library/LibraryContext";
import type { KakaoSeriesCandidate, LibraryGateway } from "../library/types";
import { KakaoConnectDialog } from "./KakaoConnectDialog";

afterEach(() => { cleanup(); vi.useRealTimers(); });

it('keeps a server-pending selection separate from confirmed completion and checks the same choice again', async () => {
  const user = userEvent.setup();
  const applyKakao = vi.fn().mockResolvedValueOnce({outcome: 'pending', message: null}).mockResolvedValueOnce({outcome: 'applied', message: null});
  const {onApplied, onClose} = renderDialog({applyKakao});
  await user.click(screen.getByRole('button', {name: '검색'}));
  await user.click(await screen.findByRole('button', {name: /던전밥.*쿠이 료코/}));
  await user.click(screen.getByRole('button', {name: '연결'}));
  expect(await screen.findByText('연결 대기 · 서버에서 처리 중')).toBeInTheDocument();
  expect(onApplied).not.toHaveBeenCalled(); expect(onClose).not.toHaveBeenCalled();
  await user.click(screen.getByRole('button', {name: '연결 상태 확인'}));
  expect(applyKakao.mock.calls[0][0]).toEqual(applyKakao.mock.calls[1][0]);
  expect(onApplied).toHaveBeenCalledWith({outcome: 'applied', message: null});
});

it('shows a server failure and allows a new deliberate request', async () => {
  const user = userEvent.setup();
  const applyKakao = vi.fn().mockResolvedValue({outcome: 'failed', message: '연결이 바뀌었습니다. 다시 선택해 주세요.'});
  const {onApplied, onClose} = renderDialog({applyKakao});
  await user.click(screen.getByRole('button', {name: '검색'}));
  await user.click(await screen.findByRole('button', {name: /던전밥.*쿠이 료코/}));
  await user.click(screen.getByRole('button', {name: '연결'}));
  expect(await screen.findByRole('alert')).toHaveTextContent('연결이 바뀌었습니다. 다시 선택해 주세요.');
  expect(onApplied).not.toHaveBeenCalled(); expect(onClose).not.toHaveBeenCalled();
  await user.click(screen.getByRole('button', {name: '다시 시도'}));
  expect(applyKakao).toHaveBeenCalledTimes(2);
});

it("preselects only already bound groups when multiple editions exactly match", async () => {
  const editions = ["bound", "other"].map(groupFingerprint => ({...candidates[0], groupFingerprint}));
  const gateway = {searchKakao: vi.fn().mockResolvedValue(editions)} as unknown as LibraryGateway;
  render(<LibraryProvider gateway={gateway}><KakaoConnectDialog open collectionId="work" initialQuery="던전 밥" autoSearch initialGroupFingerprints={["bound"]} onClose={vi.fn()} onApplied={vi.fn()} /></LibraryProvider>);
  const choices = await screen.findAllByRole("button", {name: /던전밥.*쿠이 료코.*소미미디어/});
  expect(choices.map(choice => choice.getAttribute("aria-pressed"))).toEqual(["true", "false"]);
});

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
  const view = render(
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
  return { gateway, onClose, onApplied, ...view };
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
    expect(screen.getByText("같은 권이 겹쳐 제외된 상품 2개")).toBeInTheDocument();
    expect(screen.queryByText(/권 번호를 알 수 없거나/)).not.toBeInTheDocument();
  });

  it("reports products left out as not a volume separately from duplicate volumes", async () => {
    const user = userEvent.setup();
    renderDialog({ searchKakao: vi.fn().mockResolvedValue([{ ...candidates[0], unparsedCount: 4 }]) });

    await user.click(screen.getByRole("button", { name: "검색" }));

    expect(await screen.findByText("권 번호를 알 수 없거나 세트·가이드라서 제외된 상품 4개")).toBeInTheDocument();
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
    expect(screen.getByRole("button", { name: "검색" })).toBeDisabled();
    expect(screen.queryByText("검색 중…")).not.toBeInTheDocument();
    await user.keyboard("{Escape}");
    expect(onClose).not.toHaveBeenCalled();
    resolveSearch([]);
    expect(await screen.findByText("검색 결과 없음")).toBeInTheDocument();

    vi.mocked(gateway.searchKakao).mockRejectedValueOnce(new Error("검색 실패"));
    await user.click(screen.getByRole("button", { name: "검색" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("검색 실패");
  });
});

async function prepareRecheck() {
  const user = userEvent.setup();
  const rendered = renderDialog();
  await user.click(screen.getByRole("button", { name: "검색" }));
  await user.click(await screen.findByRole("button", { name: /던전밥.*쿠이 료코/ }));
  return { ...rendered, apply: vi.mocked(rendered.gateway.applyKakao) };
}

async function startPending(apply: Awaited<ReturnType<typeof prepareRecheck>>["apply"]) {
  vi.useFakeTimers();
  apply.mockResolvedValue({ outcome: 'pending', message: null });
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: '연결' })); });
  expect(screen.getByText('연결 대기 · 서버에서 처리 중')).toBeInTheDocument();
}

async function advanceRecheck(milliseconds: number) {
  await act(async () => { await vi.advanceTimersByTimeAsync(milliseconds); });
}

describe('pending bind rechecks', () => {
  it('rechecks after 1.5 seconds with the same request and confirms once', async () => {
    const { apply, onApplied, onClose } = await prepareRecheck();
    await startPending(apply);
    const applied = { outcome: 'applied' as const, message: null };
    apply.mockResolvedValueOnce(applied);
    await advanceRecheck(1_499);
    expect(apply).toHaveBeenCalledTimes(1);
    await advanceRecheck(1);
    expect(apply).toHaveBeenCalledTimes(2);
    expect(apply.mock.calls[1][0]).toEqual(apply.mock.calls[0][0]);
    expect(onApplied).toHaveBeenCalledExactlyOnceWith(applied);
    expect(onClose).toHaveBeenCalledTimes(1);
    await advanceRecheck(120_000);
    expect(apply).toHaveBeenCalledTimes(2);
  });

  it.each(['failed', 'superseded', 'error'] as const)('shows %s and stops checking', async outcome => {
    const { apply, onApplied, onClose } = await prepareRecheck();
    await startPending(apply);
    if (outcome === 'error') apply.mockRejectedValueOnce(new Error('연결 확인 실패'));
    else apply.mockResolvedValueOnce({ outcome, message: '연결 확인 실패' });
    await advanceRecheck(1_500);
    expect(screen.getByRole('alert')).toHaveTextContent('연결 확인 실패');
    expect(screen.queryByText('연결 대기 · 서버에서 처리 중')).not.toBeInTheDocument();
    await advanceRecheck(120_000);
    expect(apply).toHaveBeenCalledTimes(2);
    expect(onApplied).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });

  it('stops scheduled checks on unmount', async () => {
    const { apply, unmount, onApplied } = await prepareRecheck();
    await startPending(apply);
    unmount();
    await advanceRecheck(120_000);
    expect(apply).toHaveBeenCalledTimes(1);
    expect(onApplied).not.toHaveBeenCalled();
  });

  it('stops scheduled checks when open becomes false', async () => {
    const { apply, gateway, rerender, onApplied, onClose } = await prepareRecheck();
    await startPending(apply);
    rerender(<LibraryProvider gateway={gateway}><KakaoConnectDialog open={false} collectionId="collection-1" initialQuery="던전밥" onApplied={onApplied} onClose={onClose} /></LibraryProvider>);
    await advanceRecheck(120_000);
    expect(apply).toHaveBeenCalledTimes(1);
    expect(onApplied).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });

  it('replays every selected group and the submitted query', async () => {
    const user = userEvent.setup();
    const editions = [candidates[0], { ...candidates[0], anchorItemId: 'item-2', groupFingerprint: 'fingerprint-b', publisher: '다른 출판사' }];
    const { gateway, onApplied, onClose } = renderDialog({ searchKakao: vi.fn().mockResolvedValue(editions) });
    await user.click(screen.getByRole('button', { name: '검색' }));
    const choices = await screen.findAllByRole('checkbox', { name: '던전밥 1–3권 함께 연결' });
    await user.click(choices[0]);
    await user.click(choices[1]);
    const apply = vi.mocked(gateway.applyKakao);
    vi.useFakeTimers();
    apply.mockResolvedValueOnce({ outcome: 'pending', message: null }).mockResolvedValueOnce({ outcome: 'applied', message: null });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '2개 연결' })); });
    fireEvent.change(screen.getByRole('searchbox', { name: '카카오 작품 검색' }), { target: { value: '다른 검색어' } });
    await advanceRecheck(1_500);
    const request = {
      collectionId: 'collection-1', query: '던전밥',
      groups: editions.map(({ anchorItemId, groupFingerprint }) => ({ anchorItemId, groupFingerprint })),
    };
    expect(apply.mock.calls.map(([argument]) => argument)).toEqual([request, request]);
    expect(onApplied).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('stops on cancel even before the parent removes the dialog', async () => {
    const { apply, onClose } = await prepareRecheck();
    await startPending(apply);
    fireEvent.click(screen.getByRole('button', { name: '취소' }));
    await advanceRecheck(120_000);
    expect(apply).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('keeps pending steady during a slow check and never overlaps calls', async () => {
    const { apply, onApplied, onClose } = await prepareRecheck();
    await startPending(apply);
    let resolve!: (result: Awaited<ReturnType<typeof apply>>) => void;
    apply.mockImplementationOnce(() => new Promise(done => { resolve = done; }));
    await advanceRecheck(1_500);
    await advanceRecheck(10_000);
    const check = screen.getByRole('button', { name: '연결 상태 확인' });
    expect(check).toBeDisabled();
    fireEvent.click(check);
    expect(apply).toHaveBeenCalledTimes(2);
    expect(screen.getByText('연결 대기 · 서버에서 처리 중')).toBeInTheDocument();
    expect(screen.queryByText('연결 중…')).not.toBeInTheDocument();
    // Closing an in-flight background request also ignores its eventual reply.
    fireEvent.click(screen.getByRole('button', { name: '취소' }));
    await act(async () => { resolve({ outcome: 'applied' as const, message: null }); });
    await advanceRecheck(120_000);
    expect(apply).toHaveBeenCalledTimes(2);
    expect(onApplied).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('uses three-second intervals, stops at two minutes and allows a manual check', async () => {
    const { apply, onApplied } = await prepareRecheck();
    await startPending(apply);
    await advanceRecheck(1_500);
    expect(apply).toHaveBeenCalledTimes(2);
    await advanceRecheck(2_999);
    expect(apply).toHaveBeenCalledTimes(2);
    await advanceRecheck(1);
    expect(apply).toHaveBeenCalledTimes(3);
    await advanceRecheck(115_500);
    expect(apply).toHaveBeenCalledTimes(41);
    expect(screen.getByText('연결 대기 · 서버에서 처리 중')).toBeInTheDocument();
    await advanceRecheck(120_000);
    expect(apply).toHaveBeenCalledTimes(41);
    const check = screen.getByRole('button', { name: '연결 상태 확인' });
    expect(check).toBeEnabled();
    apply.mockResolvedValueOnce({ outcome: 'applied' as const, message: null });
    await act(async () => { fireEvent.click(check); });
    expect(apply).toHaveBeenCalledTimes(42);
    expect(onApplied).toHaveBeenCalledTimes(1);
  });
});
