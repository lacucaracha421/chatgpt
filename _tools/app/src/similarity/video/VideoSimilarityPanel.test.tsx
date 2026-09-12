import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { PrivacyProvider } from "../../privacy/PrivacyContext";
import { VideoSimilarityPanel } from "./VideoSimilarityPanel";
import type { VideoReview, VideoScanProgress, VideoSimilarityApi } from "./client";

vi.mock("../../video/VideoPlayer", () => ({ VideoPlayer: ({ asset }: { asset: { id: string } }) => <video data-testid={`player-${asset.id}`} /> }));
afterEach(() => { cleanup(); vi.useRealTimers(); });
const progress = (state = "running"): VideoScanProgress => ({ id: "scan", state, total: 2, completed: 0, failed: 0, skipped: 0, candidateCount: 0, activeAssetId: null, reason: null });
function pair(): VideoReview {
  const asset = (id: string) => ({ id, title: null, originalName: `${id}.mp4`, byteSize: 2048, width: 1280, height: 720, collectedAt: "2026-09-08T00:00:00Z", favorite: false, sourceUrl: null, sourcePublishedAt: null, creatorName: null, creatorHandle: null, creatorUrl: null, importSource: null, importBatchId: null, originalModifiedAt: null, media: { kind: "video" as const, durationMs: 12_000, preparationState: "ready" as const, scrubFrameCount: 0 } });
  return { id: "pair", left: asset("left"), right: asset("right"), createdAt: "2026-09-08T00:00:00Z", evidence: { profile: "test", leftDurationMs: 12_000, rightDurationMs: 12_000, matchedFrames: 10, attemptedFrames: 12, validFrames: 12, matchingSpanPermille: 800, matches: [{ leftRequestedAtMs: 1000, rightRequestedAtMs: 1000, distance: 12, leftQuality: 100, rightQuality: 100 }] } };
}
function api(): VideoSimilarityApi {
  return { start: vi.fn().mockResolvedValue(progress()), latest: vi.fn().mockResolvedValue(null), get: vi.fn().mockResolvedValue(progress()), cancel: vi.fn().mockResolvedValue(progress("cancelled")), resume: vi.fn().mockResolvedValue(progress()), list: vi.fn().mockResolvedValue({ items: [pair()], totalCount: 1, nextCursor: null }), decide: vi.fn().mockResolvedValue(undefined) };
}

it("starts only on explicit request and permits cancellation", async () => {
  const client = api();
  render(<VideoSimilarityPanel assetIds={["left", "right"]} api={client} onClose={vi.fn()} />);
  await screen.findByText("left.mp4");
  expect(client.start).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "선택한 영상 2개 분석" }));
  await waitFor(() => expect(client.start).toHaveBeenCalledWith(["left", "right"]));
  fireEvent.click(await screen.findByRole("button", { name: "분석 중지" }));
  await waitFor(() => expect(client.cancel).toHaveBeenCalledWith("scan"));
  expect(await screen.findByRole("button", { name: "이전 분석 이어서" })).toBeEnabled();
});

it("restores a paused durable scan without starting or resuming automatically", async () => {
  const client = api();
  vi.mocked(client.latest).mockResolvedValue(progress("paused"));
  render(<VideoSimilarityPanel assetIds={[]} api={client} onClose={vi.fn()} />);
  fireEvent.click(await screen.findByRole("button", { name: "이전 분석 이어서" }));
  await waitFor(() => expect(client.resume).toHaveBeenCalledWith("scan"));
  expect(client.start).not.toHaveBeenCalled();
});

it.each(["keep_left", "keep_right", "keep_both", "not_similar"] as const)("sends the explicit %s decision without replacing either asset locally", async (decision) => {
  const client = api();
  const labels = { keep_left: "왼쪽 보관 · 오른쪽 휴지통", keep_right: "오른쪽 보관 · 왼쪽 휴지통", keep_both: "둘 다 보관", not_similar: "다른 영상" };
  let fail!: (error: Error) => void;
  vi.mocked(client.decide).mockImplementation(() => new Promise((_resolve, reject) => { fail = reject; }));
  render(<VideoSimilarityPanel assetIds={[]} api={client} onClose={vi.fn()} />);
  await screen.findByText("left.mp4");
  fireEvent.click(screen.getByRole("button", { name: labels[decision] }));
  fireEvent.click(screen.getByRole("button", { name: labels[decision] }));
  expect(client.decide).toHaveBeenCalledExactlyOnceWith("pair", decision);
  expect(screen.getByRole("button", { name: "다른 영상" })).toBeDisabled();
  await act(async () => fail(new Error("source changed")));
  expect(screen.getByText("left.mp4")).toBeInTheDocument();
  expect(screen.getByText("right.mp4")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "다른 영상" })).toBeEnabled();
});

it("advances only after a successful persisted decision", async () => {
  const client = api();
  vi.mocked(client.list).mockResolvedValueOnce({ items: [pair()], totalCount: 1, nextCursor: null }).mockResolvedValue({ items: [], totalCount: 0, nextCursor: null });
  render(<VideoSimilarityPanel assetIds={[]} api={client} onClose={vi.fn()} />);
  fireEvent.click(await screen.findByRole("button", { name: "둘 다 보관" }));
  expect(await screen.findByRole("heading", { name: "검토할 유사 영상이 없습니다" })).toBeInTheDocument();
});

it("unmounts both players when privacy is enabled", async () => {
  const client = api();
  const view = (privacyMode: boolean) => <PrivacyProvider privacyMode={privacyMode} setPrivacyMode={vi.fn()}><VideoSimilarityPanel assetIds={[]} api={client} onClose={vi.fn()} /></PrivacyProvider>;
  const result = render(view(false));
  await screen.findByTestId("player-left");
  result.rerender(view(true));
  expect(result.container.querySelector("video, img")).toBeNull();
  expect(screen.getAllByLabelText("비공개 모드")).toHaveLength(2);
});

it("uses thumbnails until playback preparation is ready", async () => {
  const client = api();
  const review = pair();
  review.right.media = { kind: "video", durationMs: 12_000, preparationState: "pending", scrubFrameCount: 0 };
  vi.mocked(client.list).mockResolvedValue({ items: [review], totalCount: 1, nextCursor: null });
  render(<VideoSimilarityPanel assetIds={[]} api={client} onClose={vi.fn()} />);
  expect(await screen.findByRole("img", { name: "오른쪽 영상" })).toHaveAttribute("src", "http://lakomics.localhost/thumbnail/right");
  expect(screen.queryByTestId("player-right")).not.toBeInTheDocument();
});

it("ignores an obsolete poll response after cancellation", async () => {
  vi.useFakeTimers();
  const client = api();
  vi.mocked(client.latest).mockResolvedValue(progress());
  let resolvePoll!: (next: VideoScanProgress) => void;
  vi.mocked(client.get).mockImplementation(() => new Promise((resolve) => { resolvePoll = resolve; }));
  render(<VideoSimilarityPanel assetIds={[]} api={client} onClose={vi.fn()} />);
  await act(async () => {});
  await act(async () => { await vi.advanceTimersByTimeAsync(1200); });
  fireEvent.click(screen.getByRole("button", { name: "분석 중지" }));
  await act(async () => {});
  await act(async () => resolvePoll(progress()));
  expect(screen.queryByRole("button", { name: "분석 중지" })).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "이전 분석 이어서" })).toBeInTheDocument();
});

it("ignores a late initial scan lookup after an explicit start", async () => {
  const client = api();
  let resolveLatest!: (next: VideoScanProgress) => void;
  vi.mocked(client.latest).mockImplementation(() => new Promise((resolve) => { resolveLatest = resolve; }));
  render(<VideoSimilarityPanel assetIds={["left", "right"]} api={client} onClose={vi.fn()} />);
  await screen.findByText("left.mp4");
  fireEvent.click(screen.getByRole("button", { name: "선택한 영상 2개 분석" }));
  await screen.findByRole("button", { name: "분석 중지" });
  await act(async () => resolveLatest({ ...progress("paused"), id: "old-scan" }));
  expect(screen.queryByRole("button", { name: "이전 분석 이어서" })).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "분석 중지" })).toBeInTheDocument();
});

it("does not restore a resolved pair from an older in-flight list", async () => {
  vi.useFakeTimers();
  const client = api();
  let resolveOldList!: (page: Awaited<ReturnType<VideoSimilarityApi["list"]>>) => void;
  vi.mocked(client.latest).mockResolvedValue(progress());
  vi.mocked(client.list).mockResolvedValueOnce({ items: [pair()], totalCount: 1, nextCursor: null }).mockImplementationOnce(() => new Promise((resolve) => { resolveOldList = resolve; })).mockResolvedValue({ items: [], totalCount: 0, nextCursor: null });
  render(<VideoSimilarityPanel assetIds={[]} api={client} onClose={vi.fn()} />);
  await act(async () => {});
  await act(async () => { await vi.advanceTimersByTimeAsync(1200); });
  fireEvent.click(screen.getByRole("button", { name: "둘 다 보관" }));
  await act(async () => {});
  await act(async () => resolveOldList({ items: [pair()], totalCount: 1, nextCursor: null }));
  expect(screen.getByRole("heading", { name: "검토할 유사 영상이 없습니다" })).toBeInTheDocument();
});

it("closes once with Escape from a focused control", async () => {
  const onClose = vi.fn();
  render(<VideoSimilarityPanel assetIds={[]} api={api()} onClose={onClose} />);
  const button = await screen.findByRole("button", { name: "둘 다 보관" });
  button.focus();
  fireEvent.keyDown(button, { key: "Escape" });
  expect(onClose).toHaveBeenCalledOnce();
});
