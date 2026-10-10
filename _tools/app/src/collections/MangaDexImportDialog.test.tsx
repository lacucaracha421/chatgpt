import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LibraryProvider } from "../library/LibraryContext";
import type { CollectionSummary, LibraryGateway, MangaDexWorkPreview } from "../library/types";
import { MangaDexImportDialog } from "./MangaDexImportDialog";

afterEach(() => { cleanup(); vi.useRealTimers(); });

const preview: MangaDexWorkPreview = {
  mangaId: "manga-1",
  proposedTitle: "던전밥",
  alternateTitles: ["Delicious in Dungeon"],
  author: "쿠이 료코",
  year: 2014,
  status: "completed",
  genres: "판타지, 코미디",
  overview: "던전에서 식재료를 구하는 모험 이야기",
  covers: [
    { coverId: "cover-1", fileName: "cover-1.jpg", volume: "1", language: "ja" },
    { coverId: "cover-2", fileName: "cover-2.jpg", volume: "2", language: "ja" },
  ],
};

const collection = {
  id: "collection-1",
  name: "던전밥",
  type: "manga",
} as CollectionSummary;

function renderDialog(target: { kind: "new" } | { kind: "existing"; collection: CollectionSummary } = { kind: "new" }) {
  const gateway = {
    searchMangaDex: vi.fn().mockResolvedValue([{
      mangaId: "manga-1",
      title: "던전밥",
      alternateTitles: ["Delicious in Dungeon"],
      author: "쿠이 료코",
      year: 2014,
      status: "completed",
      primaryCoverFileName: "cover-1.jpg",
    }]),
    previewMangaDex: vi.fn().mockResolvedValue(preview),
    applyMangaDex: vi.fn().mockResolvedValue(collection),
  } as unknown as LibraryGateway;
  const onApplied = vi.fn().mockResolvedValue(undefined);

  const onClose = vi.fn();
  const view = render(
    <LibraryProvider gateway={gateway}>
      <MangaDexImportDialog open target={target} onClose={onClose} onApplied={onApplied} />
    </LibraryProvider>,
  );
  return { gateway, onApplied, onClose, ...view };
}

describe("MangaDexImportDialog", () => {
  it("selects a text result and creates without requesting or choosing a cover", async () => {
    const user = userEvent.setup();
    const { gateway, onApplied } = renderDialog();

    await user.type(screen.getByRole("searchbox", { name: "만화 검색" }), "  던전밥  ");
    await user.click(screen.getByRole("button", { name: "검색" }));
    expect(gateway.searchMangaDex).toHaveBeenCalledWith("던전밥");

    const result = await screen.findByRole("button", { name: /던전밥/ });
    expect(screen.queryByRole("img")).not.toBeInTheDocument();
    await user.click(result);

    expect(gateway.previewMangaDex).not.toHaveBeenCalled();
    expect(result).toHaveAttribute("aria-pressed", "true");
    expect(screen.queryByRole("img")).not.toBeInTheDocument();
    const apply = screen.getByRole("button", { name: "작품 만들기" });
    expect(apply).toBeEnabled();
    await user.click(apply);

    await waitFor(() => expect(gateway.applyMangaDex).toHaveBeenCalledWith({
      target: { kind: "new", name: "던전밥" },
      mangaId: "manga-1",
      title: "던전밥",
    }));
    expect(onApplied).toHaveBeenCalledWith(collection);
  });

  it("prefills the search with the original title when connecting an existing manga", async () => {
    const user = userEvent.setup();
    const { gateway } = renderDialog({ kind: "existing", collection: { ...collection, originalTitle: " ダンジョン飯 " } });

    const box = screen.getByRole("searchbox", { name: "만화 검색" });
    expect(box).toHaveValue("ダンジョン飯");
    await user.click(screen.getByRole("button", { name: "검색" }));
    expect(gateway.searchMangaDex).toHaveBeenCalledWith("ダンジョン飯", collection.id);
  });

  it("starts empty for a new work or a manga without an original title", () => {
    renderDialog({ kind: "existing", collection: { ...collection, originalTitle: null } });
    expect(screen.getByRole("searchbox", { name: "만화 검색" })).toHaveValue("");
    cleanup();
    renderDialog();
    expect(screen.getByRole("searchbox", { name: "만화 검색" })).toHaveValue("");
  });

  it("keeps the selected preview when applying to an existing collection fails", async () => {
    const user = userEvent.setup();
    const existing = { ...collection, id: "collection-9" };
    const { gateway } = renderDialog({ kind: "existing", collection: existing });
    vi.mocked(gateway.applyMangaDex).mockRejectedValueOnce(new Error("연결하지 못했습니다."));

    await user.type(screen.getByRole("searchbox", { name: "만화 검색" }), "던전밥");
    await user.click(screen.getByRole("button", { name: "검색" }));
    const result = await screen.findByRole("button", { name: /던전밥/ });
    await user.click(result);
    await user.click(screen.getByRole("button", { name: "연결" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("연결하지 못했습니다.");
    expect(result).toHaveAttribute("aria-pressed", "true");
    expect(gateway.previewMangaDex).not.toHaveBeenCalled();
    expect(gateway.applyMangaDex).toHaveBeenCalledWith({
      target: { kind: "existing", collectionId: "collection-9" },
      mangaId: "manga-1",
      title: "던전밥",
    });
  });
});

async function selectExisting() {
  const user = userEvent.setup();
  const rendered = renderDialog({kind: "existing", collection});
  await user.type(screen.getByRole("searchbox", {name: "만화 검색"}), "던전밥");
  await user.click(screen.getByRole("button", {name: "검색"}));
  await user.click(await screen.findByRole("button", {name: /던전밥/}));
  return {user, ...rendered};
}

it("keeps pending open and confirms only after the pulled collection arrives", async () => {
  const {user, gateway, onApplied, onClose} = await selectExisting();
  vi.mocked(gateway.applyMangaDex).mockResolvedValueOnce({outcome: 'pending', message: null});
  await user.click(screen.getByRole('button', {name: '연결'}));
  expect(await screen.findByText('연결 대기 · 서버에서 처리 중')).toBeInTheDocument();
  expect(onApplied).not.toHaveBeenCalled();
  expect(onClose).not.toHaveBeenCalled();
  vi.mocked(gateway.applyMangaDex).mockResolvedValueOnce({outcome: 'applied', message: null, collection});
  await user.click(screen.getByRole('button', {name: '연결 상태 확인'}));
  await waitFor(() => expect(onApplied).toHaveBeenCalledWith(collection));
  expect(onClose).toHaveBeenCalledTimes(1);
});

it.each(['failed', 'superseded'] as const)('shows a %s outcome inline without confirming', async outcome => {
  const {user, gateway, onApplied, onClose} = await selectExisting();
  vi.mocked(gateway.applyMangaDex).mockResolvedValueOnce({outcome, message: '다시 선택해 주세요.'});
  await user.click(screen.getByRole('button', {name: '연결'}));
  expect(await screen.findByRole('alert')).toHaveTextContent('다시 선택해 주세요.');
  expect(onApplied).not.toHaveBeenCalled();
  expect(onClose).not.toHaveBeenCalled();
  expect(screen.getByRole('button', {name: /던전밥/})).toHaveAttribute('aria-pressed', 'true');
});

it('does not confirm applied without a confirmed collection', async () => {
  const {user, gateway, onApplied} = await selectExisting();
  vi.mocked(gateway.applyMangaDex).mockResolvedValueOnce({outcome: 'applied', message: null});
  await user.click(screen.getByRole('button', {name: '연결'}));
  expect(await screen.findByRole('alert')).toHaveTextContent('연결된 작품 정보를 확인하지 못했습니다.');
  expect(onApplied).not.toHaveBeenCalled();
});

async function prepareRecheck() {
  const rendered = await selectExisting();
  return { ...rendered, apply: vi.mocked(rendered.gateway.applyMangaDex) };
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
    const applied = { outcome: 'applied' as const, message: null, collection };
    apply.mockResolvedValueOnce(applied);
    await advanceRecheck(1_499);
    expect(apply).toHaveBeenCalledTimes(1);
    await advanceRecheck(1);
    expect(apply).toHaveBeenCalledTimes(2);
    expect(apply.mock.calls[1][0]).toEqual(apply.mock.calls[0][0]);
    expect(onApplied).toHaveBeenCalledExactlyOnceWith(collection);
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
    rerender(<LibraryProvider gateway={gateway}><MangaDexImportDialog open={false} target={{ kind: 'existing', collection }} onApplied={onApplied} onClose={onClose} /></LibraryProvider>);
    await advanceRecheck(120_000);
    expect(apply).toHaveBeenCalledTimes(1);
    expect(onApplied).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
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
    await act(async () => { resolve({ outcome: 'applied' as const, message: null, collection }); });
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
    apply.mockResolvedValueOnce({ outcome: 'applied' as const, message: null, collection });
    await act(async () => { fireEvent.click(check); });
    expect(apply).toHaveBeenCalledTimes(42);
    expect(onApplied).toHaveBeenCalledTimes(1);
  });
});
