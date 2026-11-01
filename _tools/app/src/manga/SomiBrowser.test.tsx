import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { LibraryProvider } from "../library/LibraryContext";
import type { LibraryGateway, SomiPost, SomiStatus } from "../library/types";
import { SomiBrowser } from "./SomiBrowser";

vi.mock("./PageViewer", () => ({ PageViewer: (props: { title: string; initialPage: number; pageUrls: string[]; bookmark?: { bookmarked: boolean; onToggle(): void }; onClose(): void; onPageChange(page: number): void; onRetryPage(): Promise<void> }) =>
  <div role="dialog" aria-label={props.title}>
    <span>읽던 페이지 {props.initialPage}</span><span>{props.pageUrls.join(",")}</span>
    <button onClick={() => props.onPageChange(4)}>다음 페이지</button>
    <button onClick={() => void props.onRetryPage()}>이미지 다시 시도</button>
    <button onClick={props.onClose}>뷰어 닫기</button>
    <button onClick={props.bookmark?.onToggle}>{props.bookmark?.bookmarked ? "뷰어 북마크 해제" : "뷰어 북마크"}</button>
  </div> }));
afterEach(() => { cleanup(); vi.useRealTimers(); });
const loggedOut: SomiStatus = { loggedIn: false, handle: null, displayName: null, collected: 0, total: null, complete: false, syncing: false };
const loggedIn: SomiStatus = { ...loggedOut, loggedIn: true, handle: "reader", displayName: "독자", collected: 1, total: 1, complete: true };
const post: SomiPost = { bookmarked: false, id: "post", seconds: 1, nanos: 0, title: "소미 작품", writerHandle: "writer", writerName: "작가", views: 100, votes: 12, comments: 3, coverKey: null, cover: null, pages: null };
function setup(status = loggedOut, bookmarked = false) {
  const gateway = {
    somiStatus: vi.fn().mockResolvedValue(status), somiOpenLogin: vi.fn().mockResolvedValue(undefined), somiLogout: vi.fn().mockResolvedValue(undefined),
    somiSyncNow: vi.fn().mockResolvedValue(undefined),
    somiSearch: vi.fn().mockResolvedValue({ items: [post], total: 1 }),
    somiOpenPost: vi.fn().mockResolvedValue({ title: post.title, writer: post.writerName, pageUrls: ["https://gimel.mittere.io/page"], initialPage: 3 }),
    somiFillCovers: vi.fn<(ids: string[]) => Promise<{ id: string; cover: string }[]>>().mockResolvedValue([]),
    somiToggleBookmark: vi.fn().mockResolvedValue(true),
    somiSavePage: vi.fn().mockResolvedValue(undefined),
  };
  const onReady = vi.fn(), onSourceChange = vi.fn();
  const view = render(<LibraryProvider gateway={gateway as unknown as LibraryGateway}><SomiBrowser active requested bookmarked={bookmarked} onReady={onReady} onSourceChange={onSourceChange} /></LibraryProvider>);
  return { ...view, gateway, onReady, onSourceChange };
}
it("bookmarks instantly without opening and shares the toggle with the viewer", async () => {
  const { gateway } = setup(loggedIn);
  const card = await screen.findByRole("button", { name: "소미 작품 읽기" });
  let finish!: (value: boolean) => void;
  gateway.somiToggleBookmark.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  await userEvent.click(screen.getByRole("button", { name: "소미 작품 북마크" }));
  expect(screen.getByRole("button", { name: "소미 작품 북마크 해제" })).toHaveAttribute("aria-pressed", "true");
  expect(gateway.somiOpenPost).not.toHaveBeenCalled();
  expect(screen.getByRole("button", { name: "소미 작품 읽기" })).toBe(card);
  await act(async () => finish(true));
  await userEvent.click(card);
  gateway.somiToggleBookmark.mockResolvedValueOnce(false);
  await userEvent.click(await screen.findByRole("button", { name: "뷰어 북마크 해제" }));
  expect(await screen.findByRole("button", { name: "소미 작품 북마크" })).toHaveAttribute("aria-pressed", "false");
  expect(gateway.somiToggleBookmark).toHaveBeenCalledTimes(2);
  expect(gateway.somiOpenPost).toHaveBeenCalledOnce();
});
it("keeps board and bookmark sort, period and mounted lists independent without a display group", async () => {
  const { gateway, rerender, onReady, onSourceChange } = setup(loggedIn);
  const show = (bookmarked: boolean) => rerender(<LibraryProvider gateway={gateway as unknown as LibraryGateway}>
    <SomiBrowser active requested bookmarked={bookmarked} onReady={onReady} onSourceChange={onSourceChange} />
  </LibraryProvider>);
  await screen.findByRole("button", { name: "소미 작품 읽기" });
  await userEvent.click(screen.getByRole("button", { name: "보기" }));
  expect(screen.queryByText("표시")).not.toBeInTheDocument();
  expect(screen.queryByRole("menuitemradio", { name: "추가순" })).not.toBeInTheDocument();
  await userEvent.click(screen.getByRole("menuitemradio", { name: "1개월" }));
  await waitFor(() => expect(gateway.somiSearch).toHaveBeenLastCalledWith("", "votes", 1, 30, false));
  await userEvent.click(screen.getByRole("button", { name: "보기" }));
  await userEvent.click(screen.getByRole("menuitemradio", { name: "조회순" }));
  await waitFor(() => expect(gateway.somiSearch).toHaveBeenLastCalledWith("", "views", 1, 30, false));
  const boardCard = screen.getByRole("button", { name: "소미 작품 읽기" });
  show(true);
  await waitFor(() => expect(gateway.somiSearch).toHaveBeenLastCalledWith("", "added", 1, null, true));
  await waitFor(() => expect(screen.getByRole("button", { name: "소미 작품 읽기" })).not.toBe(boardCard));
  const bookmarkCard = screen.getByRole("button", { name: "소미 작품 읽기" });
  await userEvent.click(screen.getByRole("button", { name: "보기" }));
  expect(screen.getByRole("menuitemradio", { name: "추가순" })).toHaveAttribute("aria-checked", "true");
  await userEvent.click(screen.getByRole("menuitemradio", { name: "오래된순" }));
  await waitFor(() => expect(gateway.somiSearch).toHaveBeenLastCalledWith("", "old", 1, null, true));
  await waitFor(() => expect(screen.getByRole("button", { name: "소미 작품 읽기" })).not.toBe(bookmarkCard));
  const sortedBookmark = screen.getByRole("button", { name: "소미 작품 읽기" });
  show(false);
  expect(screen.getByRole("button", { name: "소미 작품 읽기" })).toBe(boardCard);
  await userEvent.click(screen.getByRole("button", { name: "보기" }));
  expect(screen.getByRole("menuitemradio", { name: "조회순" })).toHaveAttribute("aria-checked", "true");
  expect(screen.getByRole("menuitemradio", { name: "1개월" })).toHaveAttribute("aria-checked", "true");
  await userEvent.keyboard("{Escape}");
  show(true);
  expect(screen.getByRole("button", { name: "소미 작품 읽기" })).toBe(sortedBookmark);
});
it("ignores a bookmark reply after returning to the mounted board before it is ready", async () => {
  const { gateway, rerender, onReady, onSourceChange } = setup(loggedIn);
  const board = await screen.findByRole("button", { name: "소미 작품 읽기" });
  let finish!: (value: { items: SomiPost[]; total: number }) => void;
  gateway.somiSearch.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  const show = (bookmarked: boolean) => rerender(<LibraryProvider gateway={gateway as unknown as LibraryGateway}>
    <SomiBrowser active requested bookmarked={bookmarked} onReady={onReady} onSourceChange={onSourceChange} />
  </LibraryProvider>);
  show(true);
  await waitFor(() => expect(gateway.somiSearch).toHaveBeenLastCalledWith("", "added", 1, null, true));
  expect(board).toBeVisible(); expect(board).toBeDisabled();
  show(false);
  expect(board).toBeEnabled();
  await act(async () => finish({ items: [{ ...post, title: "늦은 북마크" }], total: 1 }));
  expect(screen.getByRole("button", { name: "소미 작품 읽기" })).toBe(board);
  expect(screen.queryByText("늦은 북마크")).not.toBeInTheDocument();
});
it("checks new posts from the menu and disables it while syncing", async () => {
  const { gateway } = setup(loggedIn);
  await screen.findByRole("button", { name: "소미 작품 읽기" });
  await userEvent.click(screen.getByRole("button", { name: "소미 더보기" }));
  await userEvent.click(screen.getByRole("menuitem", { name: "새 글 확인" }));
  expect(gateway.somiSyncNow).toHaveBeenCalledOnce();
  await userEvent.click(screen.getByRole("button", { name: "소미 더보기" }));
  expect(screen.getByRole("menuitem", { name: "새 글 확인" })).toBeDisabled();
  expect(screen.queryByText(/목차 모으는 중/)).not.toBeInTheDocument();
});
it("forces a sync from the stopped collection retry", async () => {
  const { gateway } = setup({ ...loggedIn, syncError: "offline" });
  await screen.findByText("목차 수집이 멈췄습니다");
  await userEvent.click(screen.getByRole("button", { name: "다시 시도" }));
  expect(gateway.somiSyncNow).toHaveBeenCalledOnce();
});
it("is ready immediately with a held list and replaces it when status reports logout", async () => {
  const { gateway, rerender, onReady, onSourceChange } = setup(loggedIn);
  await screen.findByRole("button", { name: "소미 작품 읽기" });
  const show = (requested: boolean) => rerender(<LibraryProvider gateway={gateway as unknown as LibraryGateway}>
    <SomiBrowser active={requested} requested={requested} onReady={onReady} onSourceChange={onSourceChange} />
  </LibraryProvider>);
  show(false);
  onReady.mockClear();
  let finish!: (status: SomiStatus) => void;
  gateway.somiStatus.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  show(true);
  expect(onReady).toHaveBeenCalledOnce();
  expect(screen.getByRole("button", { name: "소미 작품 읽기" })).toBeVisible();
  await act(async () => finish(loggedOut));
  expect(screen.getByText("코네 로그인이 필요합니다")).toBeVisible();
  expect(screen.queryByRole("button", { name: "소미 작품 읽기" })).not.toBeInTheDocument();
});
it("reloads an all-period first page after routine sync without collecting on polls", async () => {
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
  const { gateway } = setup({ ...loggedIn, syncing: true });
  await waitFor(() => expect(screen.getByRole("button", { name: "소미 작품 읽기" })).toBeEnabled());
  gateway.somiSearch.mockClear();
  gateway.somiStatus.mockClear().mockResolvedValue(loggedIn);
  await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
  expect(gateway.somiStatus).toHaveBeenLastCalledWith(false);
  expect(gateway.somiSearch).toHaveBeenCalledWith("", "new", 1, null, false);
});
it("keeps the held list on an offline status failure", async () => {
  const { gateway } = setup(loggedIn);
  await screen.findByRole("button", { name: "소미 작품 읽기" });
  gateway.somiStatus.mockRejectedValueOnce(new Error("offline"));
  fireEvent(window, new Event("focus"));
  await act(async () => {});
  expect(screen.getByRole("button", { name: "소미 작품 읽기" })).toBeVisible();
  expect(screen.queryByText("코네 로그인이 필요합니다")).not.toBeInTheDocument();
});
it("shows only login while logged out, then lists after focus returns from kone", async () => {
  const { gateway } = setup();
  await screen.findByText("코네 로그인이 필요합니다");
  expect(gateway.somiSearch).not.toHaveBeenCalled();
  await userEvent.click(screen.getByRole("button", { name: "코네 로그인" }));
  expect(gateway.somiOpenLogin).toHaveBeenCalledOnce();
  gateway.somiStatus.mockResolvedValue(loggedIn);
  fireEvent(window, new Event("focus"));
  expect(await screen.findByRole("button", { name: "소미 작품 읽기" })).toBeVisible();
  expect(gateway.somiOpenPost).not.toHaveBeenCalled();
});
it("opens bookmarks in the existing reader, restores and saves the page, and retries through open-post", async () => {
  const { gateway } = setup(loggedIn, true);
  await userEvent.click(await screen.findByRole("button", { name: "소미 작품 읽기" }));
  expect(await screen.findByRole("dialog", { name: "소미 작품" })).toHaveTextContent("읽던 페이지 3");
  expect(gateway.somiOpenPost).toHaveBeenCalledWith("post");
  await userEvent.click(screen.getByRole("button", { name: "다음 페이지" }));
  expect(gateway.somiSavePage).toHaveBeenCalledWith("post", 4);
  await userEvent.click(screen.getByRole("button", { name: "이미지 다시 시도" }));
  expect(gateway.somiOpenPost).toHaveBeenCalledTimes(2);
});
it("offers a retry when the first list fails", async () => {
  const { gateway } = setup(loggedIn);
  gateway.somiSearch.mockRejectedValueOnce(new Error("offline"));
  await screen.findByText("소미 목록을 불러오지 못했습니다");
  await userEvent.click(screen.getByRole("button", { name: "다시 시도" }));
  expect(await screen.findByRole("button", { name: "소미 작품 읽기" })).toBeVisible();
});
it("clears cards immediately on logout and ignores an outstanding list answer", async () => {
  const { gateway } = setup(loggedIn);
  await screen.findByRole("button", { name: "소미 작품 읽기" });
  let finishList!: (value: { items: SomiPost[]; total: number }) => void;
  gateway.somiSearch.mockImplementationOnce(() => new Promise(resolve => { finishList = resolve; }));
  await userEvent.click(screen.getByRole("button", { name: "보기" }));
  await userEvent.click(screen.getByRole("menuitemradio", { name: "조회순" }));
  let finish!: (value: unknown) => void;
  gateway.somiLogout.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  await userEvent.click(screen.getByRole("button", { name: "소미 더보기" }));
  await userEvent.click(screen.getByRole("menuitem", { name: "로그아웃" }));
  expect(screen.queryByRole("button", { name: "소미 작품 읽기" })).not.toBeInTheDocument();
  expect(screen.getByText("코네 로그인이 필요합니다")).toBeVisible();
  gateway.somiStatus.mockResolvedValue(loggedOut);
  await act(async () => finish(undefined));
  await act(async () => finishList({ items: [post], total: 1 }));
  expect(screen.queryByRole("button", { name: "소미 작품 읽기" })).not.toBeInTheDocument();
});
it("sorts by votes when a period is chosen and still lets the sort change within it", async () => {
  const { gateway } = setup(loggedIn);
  await screen.findByRole("button", { name: "소미 작품 읽기" });
  await userEvent.click(screen.getByRole("button", { name: "보기" }));
  await userEvent.click(screen.getByRole("menuitemradio", { name: "3개월" }));
  await waitFor(() => expect(gateway.somiSearch).toHaveBeenLastCalledWith("", "votes", 1, 90, false));
  await userEvent.click(screen.getByRole("button", { name: "보기" }));
  await userEvent.click(screen.getByRole("menuitemradio", { name: "조회순" }));
  await waitFor(() => expect(gateway.somiSearch).toHaveBeenLastCalledWith("", "views", 1, 90, false));
  await userEvent.click(screen.getByRole("button", { name: "보기" }));
  await userEvent.click(screen.getByRole("menuitemradio", { name: "전체" }));
  await waitFor(() => expect(gateway.somiSearch).toHaveBeenLastCalledWith("", "views", 1, null, false));
});
it("keeps the old list while a new sort is pending and sends search text without namespaces", async () => {
  const { gateway } = setup(loggedIn);
  await screen.findByRole("button", { name: "소미 작품 읽기" });
  let resolve!: (value: { items: SomiPost[]; total: number }) => void;
  gateway.somiSearch.mockImplementation(() => new Promise(done => { resolve = done; }));
  await userEvent.click(screen.getByRole("button", { name: "보기" }));
  await userEvent.click(screen.getByRole("menuitemradio", { name: "조회순" }));
  await waitFor(() => expect(gateway.somiSearch).toHaveBeenLastCalledWith("", "views", 1, null, false));
  expect(screen.getByText("소미 작품")).toBeVisible();
  await act(async () => resolve({ items: [{ ...post, id: "second", title: "다른 작품" }], total: 1 }));
  await screen.findByRole("button", { name: "다른 작품 읽기" });
});

it("shows the new period while cover filling never resolves", async () => {
  const { gateway } = setup(loggedIn);
  await screen.findByRole("button", { name: "소미 작품 읽기" });
  gateway.somiFillCovers.mockImplementation(() => new Promise(() => {}));
  gateway.somiSearch.mockResolvedValue({ items: [{ ...post, id: "month", title: "이번 달 작품", coverKey: "ab".repeat(32) }], total: 1 });
  await userEvent.click(screen.getByRole("button", { name: "보기" }));
  await userEvent.click(screen.getByRole("menuitemradio", { name: "1개월" }));
  expect(await screen.findByRole("button", { name: "이번 달 작품 읽기" })).toBeVisible();
  await waitFor(() => expect(gateway.somiFillCovers).toHaveBeenCalledWith(["month"]));
  expect(screen.queryByRole("button", { name: "소미 작품 읽기" })).not.toBeInTheDocument();
});
it("ignores a stale cover fill even when the next view contains the same post", async () => {
  const { gateway } = setup(loggedIn);
  let finish!: (covers: { id: string; cover: string }[]) => void;
  gateway.somiSearch.mockResolvedValue({ items: [{ ...post, coverKey: "ab".repeat(32) }], total: 1 });
  gateway.somiFillCovers.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  await screen.findByRole("button", { name: "소미 작품 읽기" });
  await waitFor(() => expect(gateway.somiFillCovers).toHaveBeenCalledTimes(1));
  await userEvent.click(screen.getByRole("button", { name: "보기" }));
  await userEvent.click(screen.getByRole("menuitemradio", { name: "추천순" }));
  await waitFor(() => expect(gateway.somiFillCovers).toHaveBeenCalledTimes(2));
  await act(async () => finish([{ id: post.id, cover: "https://gimel.mittere.io/stale" }]));
  expect(screen.queryByAltText("소미 작품 표지")).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "소미 작품 읽기" })).toBeVisible();
});
it("fills only the appended page and leaves failed covers silent", async () => {
  const { gateway } = setup(loggedIn);
  gateway.somiSearch.mockResolvedValueOnce({ items: [post], total: 2 });
  await screen.findByRole("button", { name: "소미 작품 읽기" });
  gateway.somiSearch.mockResolvedValueOnce({ items: [{ ...post, id: "next", title: "다음 작품", coverKey: "ab".repeat(32) }], total: 2 });
  gateway.somiFillCovers.mockRejectedValueOnce(new Error("offline"));
  await userEvent.click(screen.getByRole("button", { name: "더 불러오기" }));
  expect(await screen.findByRole("button", { name: "다음 작품 읽기" })).toBeVisible();
  await waitFor(() => expect(gateway.somiFillCovers).toHaveBeenCalledWith(["next"]));
  expect(screen.getByRole("button", { name: "소미 작품 읽기" })).toBeVisible();
  expect(screen.queryByText("소미를 불러오지 못했습니다")).not.toBeInTheDocument();
});

it("patches resolved covers into the displayed page", async () => {
  const { gateway } = setup(loggedIn);
  gateway.somiSearch.mockResolvedValue({ items: [{ ...post, coverKey: "ab".repeat(32) }], total: 1 });
  gateway.somiFillCovers.mockResolvedValue([{ id: post.id, cover: "https://gimel.mittere.io/cover" }]);
  await screen.findByRole("button", { name: "소미 작품 읽기" });
  expect(await screen.findByAltText("소미 작품 표지")).toHaveAttribute("src", "https://gimel.mittere.io/cover");
});
