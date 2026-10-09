import {act, cleanup, fireEvent, render, renderHook, screen, waitFor, within} from "@testing-library/react";
import {useRef, useState} from "react";
import {afterEach, beforeEach, expect, it, vi} from "vitest";
import type {CollectionSummary, KakaoReview, LibraryGateway} from "../library/types";
import {KakaoReviewScreen, useKakaoReviews} from "./KakaoReviewScreen";

let gateway: LibraryGateway;
vi.mock("../library/LibraryContext", () => ({useLibrary: () => ({gateway})}));
vi.mock("../privacy/PrivacyContext", () => ({usePrivacy: () => ({privacyMode: false})}));
const review = (id: string, patch: Partial<KakaoReview> = {}): KakaoReview => ({collectionId: id, query: "던전밥", querySource: "mangadex", bound: false, volumes: [], highestOwnedVolume: 14, ownedCount: 14, partialDismissed: false, groupFingerprints: [], minVolume: 2, maxVolume: 20, hideConnectionPrompt: false, dismissalSupported: true, ...patch});
const works = ["a", "b"].map((id, i) => ({id, name: `Dungeon ${i}`, type: "manga", author: "작가"} as CollectionSummary));
function Harness({initial = [review("a"), review("b")]}: {initial?: KakaoReview[]}) {
  const [reviews, setReviews] = useState(initial);
  const latest = useRef(reviews); latest.current = reviews;
  return <KakaoReviewScreen collections={works} data={{reviews, error: "", refresh: async () => {
    const next = gateway.listKakaoReviews ? await gateway.listKakaoReviews() : latest.current;
    setReviews(next); return next;
  }, update: value => { latest.current = latest.current.map(r => r.collectionId === value.collectionId ? value : r); setReviews(latest.current); }}} coverUrl={() => null} onBack={vi.fn()} onChanged={vi.fn().mockResolvedValue(undefined)} />;
}
beforeEach(() => {
  gateway = {setCollectionVolumeRange: vi.fn().mockResolvedValue({}), setKakaoPartialDismissed: vi.fn().mockResolvedValue(undefined),
    searchKakao: vi.fn().mockResolvedValue([{anchorItemId: "k1", groupFingerprint: "f", title: "던전 밥", author: "작가", publisher: "출판사", volumes: [{volumeNumber: 1, providerItemId: "k1", title: "1권"}], ignoredCount: 0}]),
    applyKakao: vi.fn().mockResolvedValue({added: 1, updated: 0, unchanged: 0, ignored: 0})} as unknown as LibraryGateway;
});
afterEach(() => {cleanup(); vi.useRealTimers(); vi.unstubAllGlobals();});
it("uses the edited query and moves keyboard focus between rows", async () => {
  gateway.listKakaoReviews = vi.fn().mockResolvedValue([review("a", {bound: true, volumes: Array.from({length: 14}, (_, i) => i + 1)}), review("b")]);
  render(<Harness />);
  const input = screen.getByRole("textbox", {name: "Dungeon 0 검색어"});
  expect(input).toHaveValue("던전밥");
  fireEvent.change(input, {target: {value: "던전 밥"}});
  fireEvent.keyDown(input, {key: "ArrowDown"});
  expect(within(document.querySelector('[data-review-id="b"]')!).getByRole("button", {name: "찾기"})).toHaveFocus();
  fireEvent.keyDown(input, {key: "Enter"});
  await waitFor(() => expect(gateway.searchKakao).toHaveBeenCalledWith("던전 밥"));
  expect(await screen.findByRole("button", {name: /던전 밥.*작가.*출판사/})).toHaveAttribute("aria-pressed", "true");
  expect(within(screen.getByRole("dialog")).getByText("Dungeon 0")).toBeInTheDocument();
  fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", {name: "연결"}));
  await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  await waitFor(() => expect(document.querySelector('[data-review-id="a"]')).toHaveClass("is-success"));
  await waitFor(() => expect(document.querySelector('[data-review-id="a"]')).toBeNull(), {timeout: 1500});
  await waitFor(() => expect(within(document.querySelector('[data-review-id="b"]')!).getByRole("button", {name: "찾기"})).toHaveFocus());
});
it("excludes and undoes without losing the configured volume range", async () => {
  render(<Harness />);
  fireEvent.click(within(document.querySelector('[data-review-id="a"]')!).getByRole("button", {name: "연결 안 함"}));
  await waitFor(() => expect(gateway.setCollectionVolumeRange).toHaveBeenCalledWith("a", {minVolume: 2, maxVolume: 20, hideConnectionPrompt: true}));
  expect(await screen.findByRole("radio", {name: "제외 1"})).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", {name: "되돌리기"}));
  await waitFor(() => expect(gateway.setCollectionVolumeRange).toHaveBeenLastCalledWith("a", {minVolume: 2, maxVolume: 20, hideConnectionPrompt: false}));
});
it("shows missing ranges and persists the partial dismissal separately", async () => {
  render(<Harness initial={[review("a", {bound: true, volumes: Array.from({length: 12}, (_, i) => i + 1)})]} />);
  fireEvent.click(screen.getByRole("radio", {name: "일부 권 1"}));
  expect(await screen.findByText("13–14권 없음")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", {name: "이대로 두기"}));
  await waitFor(() => expect(gateway.setKakaoPartialDismissed).toHaveBeenCalledWith("a", true));
  expect(gateway.setCollectionVolumeRange).not.toHaveBeenCalled();
});
it("removes a linked row immediately when reduced motion is requested", async () => {
  gateway.listKakaoReviews = vi.fn().mockResolvedValue([review("a", {bound: true, volumes: Array.from({length: 14}, (_, i) => i + 1)}), review("b")]);
  vi.stubGlobal("matchMedia", vi.fn().mockReturnValue({matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn()}));
  render(<Harness />);
  fireEvent.click(within(document.querySelector('[data-review-id="a"]')!).getByRole("button", {name: "찾기"}));
  await screen.findByRole("button", {name: /던전 밥.*작가.*출판사/});
  await act(async () => { fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", {name: "연결"})); });
  expect(document.querySelector('[data-review-id="a"]')).toBeNull();
});

it("keeps a reconnected work in partial when the refreshed volume set still has gaps", async () => {
  const partial = review("a", {bound: true, volumes: [1, 3]});
  gateway.listKakaoReviews = vi.fn().mockResolvedValue([partial]);
  render(<Harness initial={[partial]} />);
  fireEvent.click(screen.getByRole("radio", {name: "일부 권 1"}));
  fireEvent.click(await screen.findByRole("button", {name: "다시 연결"}));
  await screen.findByRole("button", {name: /던전 밥.*작가.*출판사/});
  await act(async () => fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", {name: "연결"})));
  await waitFor(() => expect(gateway.listKakaoReviews).toHaveBeenCalled());
  expect(document.querySelector('[data-review-id="a"]')).not.toHaveClass("is-success", "is-folding");
  expect(screen.queryByText("연결됨")).not.toBeInTheDocument();
  expect(screen.getByRole("button", {name: "다시 연결"})).toBeInTheDocument();
});

it("hides partial dismissal for an older server", async () => {
  render(<Harness initial={[review("a", {bound: true, volumes: [1, 3], dismissalSupported: false})]} />);
  fireEvent.click(screen.getByRole("radio", {name: "일부 권 1"}));
  await screen.findByRole("button", {name: "다시 연결"});
  expect(screen.queryByRole("button", {name: "이대로 두기"})).not.toBeInTheDocument();
  expect(gateway.setKakaoPartialDismissed).not.toHaveBeenCalled();
});

it("folds an exclusion, focuses the next row and unfolds undo", async () => {
  render(<Harness />);
  fireEvent.click(within(document.querySelector('[data-review-id="a"]')!).getByRole("button", {name: "연결 안 함"}));
  await waitFor(() => expect(document.querySelector('[data-review-id="a"]')).toHaveClass("is-folding"));
  await waitFor(() => expect(document.querySelector('[data-review-id="a"]')).toBeNull());
  await waitFor(() => expect(within(document.querySelector('[data-review-id="b"]')!).getByRole("button", {name: "찾기"})).toHaveFocus());
  fireEvent.click(screen.getByRole("button", {name: "되돌리기"}));
  await waitFor(() => expect(document.querySelector('[data-review-id="a"]')).toHaveClass("is-entering"));
  await waitFor(() => expect(within(document.querySelector('[data-review-id="a"]')!).getByRole("button", {name: "찾기"})).toHaveFocus());
});

it("does not compute on a hidden tab and debounces collection changes", async () => {
  vi.useFakeTimers();
  gateway.listKakaoReviews = vi.fn().mockResolvedValue([]);
  const {rerender} = renderHook(({active, items}) => useKakaoReviews(items, active), {initialProps: {active: false, items: works}});
  await act(async () => vi.advanceTimersByTime(500));
  expect(gateway.listKakaoReviews).not.toHaveBeenCalled();
  rerender({active: true, items: works});
  await act(async () => vi.advanceTimersByTime(100));
  rerender({active: true, items: [...works]});
  await act(async () => vi.advanceTimersByTime(100));
  expect(gateway.listKakaoReviews).not.toHaveBeenCalled();
  await act(async () => vi.advanceTimersByTime(80));
  expect(gateway.listKakaoReviews).toHaveBeenCalledTimes(1);
});

it("folds undo from the excluded segment instead of removing it abruptly", async () => {
  render(<Harness />);
  fireEvent.click(within(document.querySelector('[data-review-id="a"]')!).getByRole("button", {name: "연결 안 함"}));
  await screen.findByRole("radio", {name: "제외 1"});
  await waitFor(() => expect(document.querySelector('[data-review-id="a"]')).toBeNull());
  fireEvent.click(screen.getByRole("radio", {name: "제외 1"}));
  await screen.findByRole("button", {name: "다시 점검"});
  fireEvent.click(screen.getByRole("button", {name: "되돌리기"}));
  await waitFor(() => expect(document.querySelector('[data-review-id="a"]')).toHaveClass("is-folding"));
  await waitFor(() => expect(document.querySelector('[data-review-id="a"]')).toBeNull());
  expect(screen.getByText("제외한 작품이 없습니다.")).toBeInTheDocument();
});
