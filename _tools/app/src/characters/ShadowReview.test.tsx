import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { ShadowReview } from "./ShadowReview";
import { emptyShadowSummary, type ShadowReviewItem, type ShadowReviewPage } from "./shadowReviewApi";

afterEach(cleanup);
const idleStatus = { running: false, preparing: false, total: 0, scored: 0, skipped: 0, cancelled: false, error: null };
const idleApi = () => ({ start: vi.fn().mockResolvedValue(idleStatus), status: vi.fn().mockResolvedValue(idleStatus), cancel: vi.fn().mockResolvedValue(idleStatus) });

function item(assetId: string, verdict: ShadowReviewItem["verdict"], knn3: number, targetId = "hina"): ShadowReviewItem {
  return { origin: "live", assetId, contentHash: `hash-${assetId}`, originalName: `${assetId}.png`, width: 4, height: 3, targetId, targetName: targetId === "hina" ? "히나" : "키사키", targetFingerprint: `fp-${targetId}`, referenceAssetIds: ["ref-1", "ref-2"], verdict, knn3, nativeOutcome: "none", scoredAt: "2026-09-23T00:00:00Z" };
}

function fixture(items: ShadowReviewItem[], summary = { ...emptyShadowSummary(), automatic: { pending: items.filter(i => i.verdict === "automatic").length, accepted: 3, rejected: 1 }, recommended: { pending: items.filter(i => i.verdict === "recommended").length, accepted: 2, rejected: 4 } }) {
  const page = vi.fn(async (): Promise<ShadowReviewPage> => ({ items, nextOffset: null, policyVersion: "v1", summary }));
  const decide = vi.fn(async () => 1);
  const onClose = vi.fn(), onChanged = vi.fn();
  render(<ShadowReview onClose={onClose} onChanged={onChanged} api={{ ...idleApi(), page }} decisions={{ decide }} />);
  return { page, decide, onClose, onChanged };
}

it("shows the first candidate with its character, references, verdict, native outcome and stats", async () => {
  fixture([item("a1", "automatic", 0.1234), item("a2", "recommended", 0.145)]);
  const dialog = await screen.findByRole("dialog", { name: "S36 확인" });
  expect(within(dialog).getByRole("heading", { level: 3, name: "히나" })).toBeInTheDocument();
  expect(within(dialog).getByText("자동 후보")).toBeInTheDocument();
  expect(within(dialog).getByText("knn3 0.1234")).toBeInTheDocument();
  expect(within(dialog).getByText(/기존 판정 없음/)).toHaveTextContent("a1.png");
  expect(within(dialog).getByRole("list", { name: "히나 레퍼런스" }).querySelectorAll("img")).toHaveLength(2);
  expect(within(dialog).getByRole("img", { name: "a1.png — 히나 후보" })).toHaveAttribute("src", expect.stringContaining("/thumbnail/a1"));
  const stats = within(dialog).getByLabelText("진행 상황");
  expect(stats).toHaveTextContent("남은 항목2");
  expect(stats).toHaveTextContent("자동 후보 정확도3/4");
  expect(stats).toHaveTextContent("추천 수락2/6");
  expect(within(dialog).getByRole("button", { name: /맞음/ })).toHaveTextContent("D");
  expect(within(dialog).getByRole("button", { name: /아님/ })).toHaveTextContent("A");
  expect(within(dialog).getByRole("button", { name: /건너뛰기/ })).toHaveTextContent("S");
  expect(dialog.querySelector("[title]")).toBeNull();
});

it("accepts with the keyboard through the manual decision path, advances and updates stats", async () => {
  const { decide, onChanged } = fixture([item("a1", "automatic", 0.12), item("a2", "recommended", 0.145, "kisaki")]);
  await screen.findByRole("heading", { level: 3, name: "히나" });
  const user = userEvent.setup();
  await user.keyboard("{ArrowRight}");
  await waitFor(() => expect(decide).toHaveBeenCalledWith({ targetId: "hina", expectedFingerprint: "fp-hina", assetIds: ["a1"], decision: "accepted", baselineFingerprint: null, scanId: null }));
  expect(await screen.findByRole("heading", { level: 3, name: "키사키" })).toBeInTheDocument();
  expect(screen.getByText("추천")).toBeInTheDocument();
  expect(screen.getByLabelText("진행 상황")).toHaveTextContent("남은 항목1");
  expect(screen.getByLabelText("진행 상황")).toHaveTextContent("자동 후보 정확도4/5");
  expect(onChanged).toHaveBeenCalledTimes(1);
  await user.keyboard("a");
  await waitFor(() => expect(decide).toHaveBeenLastCalledWith(expect.objectContaining({ targetId: "kisaki", assetIds: ["a2"], decision: "rejected" })));
  expect(await screen.findByRole("heading", { name: "확인할 항목이 없습니다" })).toBeInTheDocument();
  expect(screen.getByText(/S36 시험 채점이 켜져 있어야/)).toBeInTheDocument();
  expect(screen.getByLabelText("진행 상황")).toHaveTextContent("추천 수락2/7");
});

it("rejects and skips with buttons, then offers skipped items again", async () => {
  const { decide } = fixture([item("a1", "automatic", 0.12), item("a2", "automatic", 0.13)]);
  const user = userEvent.setup();
  await user.click(await screen.findByRole("button", { name: /건너뛰기/ }));
  expect(decide).not.toHaveBeenCalled();
  expect(screen.getByText(/기존 판정/)).toHaveTextContent("a2.png");
  await user.click(screen.getByRole("button", { name: /아님/ }));
  await waitFor(() => expect(decide).toHaveBeenCalledWith(expect.objectContaining({ assetIds: ["a2"], decision: "rejected" })));
  expect(await screen.findByRole("heading", { name: "건너뛴 항목만 남았습니다" })).toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "건너뛴 항목 다시 보기" }));
  expect(await screen.findByText(/기존 판정/)).toHaveTextContent("a1.png");
});

it("undoes the last judgment by clearing it and brings the item back", async () => {
  const { decide } = fixture([item("a1", "automatic", 0.12), item("a2", "automatic", 0.13)]);
  const user = userEvent.setup();
  await user.click(await screen.findByRole("button", { name: /맞음/ }));
  await screen.findByRole("button", { name: /되돌리기: 히나 맞음/ });
  expect(screen.getByLabelText("진행 상황")).toHaveTextContent("자동 후보 정확도4/5");
  await user.keyboard("z");
  await waitFor(() => expect(decide).toHaveBeenLastCalledWith(expect.objectContaining({ assetIds: ["a1"], decision: "cleared" })));
  expect(await screen.findByText(/기존 판정/)).toHaveTextContent("a1.png");
  expect(screen.getByLabelText("진행 상황")).toHaveTextContent("자동 후보 정확도3/4");
  expect(screen.queryByRole("button", { name: /되돌리기/ })).not.toBeInTheDocument();
});

it("keeps the item and shows the native error when a judgment is refused", async () => {
  const { decide } = fixture([item("a1", "automatic", 0.12)]);
  decide.mockRejectedValueOnce({ code: "invalid_character_request", message: "시리즈 폴더 안의 지원되는 자산을 선택해 주세요." });
  const user = userEvent.setup();
  await user.click(await screen.findByRole("button", { name: /맞음/ }));
  expect(await screen.findByRole("alert")).toHaveTextContent("시리즈 폴더 안의 지원되는 자산을 선택해 주세요.");
  expect(screen.getByText(/기존 판정/)).toHaveTextContent("a1.png");
});

it("shows the empty state and a retryable load error", async () => {
  const page = vi.fn().mockRejectedValueOnce({ code: "character_storage_failed", message: "읽기 실패" }).mockResolvedValue({ items: [], nextOffset: null, policyVersion: null, summary: emptyShadowSummary() });
  render(<ShadowReview onClose={vi.fn()} api={{ ...idleApi(), page }} decisions={{ decide: vi.fn() }} />);
  expect(await screen.findByRole("alert")).toHaveTextContent("읽기 실패");
  await userEvent.setup().click(screen.getByRole("button", { name: "다시 시도" }));
  expect(await screen.findByRole("heading", { name: "확인할 항목이 없습니다" })).toBeInTheDocument();
  expect(page).toHaveBeenCalledTimes(2);
  expect(page).toHaveBeenLastCalledWith({ offset: 0, limit: 40 });
});

it("loads more with an offset that skips what it already holds", async () => {
  const first = Array.from({ length: 4 }, (_, i) => item(`a${i}`, "automatic", 0.1 + i / 100));
  const page = vi.fn()
    .mockResolvedValueOnce({ items: first, nextOffset: 4, policyVersion: "v1", summary: { ...emptyShadowSummary(), automatic: { pending: 6, accepted: 0, rejected: 0 }, recommended: { pending: 0, accepted: 0, rejected: 0 } } })
    .mockResolvedValue({ items: [item("a4", "automatic", 0.2), item("a5", "automatic", 0.21)], nextOffset: null, policyVersion: "v1", summary: { ...emptyShadowSummary(), automatic: { pending: 6, accepted: 0, rejected: 0 }, recommended: { pending: 0, accepted: 0, rejected: 0 } } });
  render(<ShadowReview onClose={vi.fn()} api={{ ...idleApi(), page }} decisions={{ decide: vi.fn(async () => 1) }} />);
  await screen.findByText(/기존 판정/);
  await waitFor(() => expect(page).toHaveBeenCalledTimes(2));
  expect(page).toHaveBeenLastCalledWith({ offset: 4, limit: 40 });
});

it("starts cached history scoring from the empty state, shows progress, cancels and refreshes", async () => {
  const user = userEvent.setup();
  const api = { ...idleApi(), page: vi.fn().mockResolvedValue({ items: [], nextOffset: null, policyVersion: null, summary: emptyShadowSummary() }) };
  api.start.mockResolvedValue({ ...idleStatus, running: true, total: 12, scored: 3, skipped: 2 });
  api.status.mockResolvedValue({ ...idleStatus, running: true, total: 12, scored: 3, skipped: 2 });
  // The initial poll is idle; subsequent polls represent the running native job.
  api.status.mockResolvedValueOnce(idleStatus);
  api.cancel.mockResolvedValue({ ...idleStatus, total: 12, scored: 3, skipped: 2, cancelled: true });
  render(<ShadowReview onClose={vi.fn()} api={api} />);
  await screen.findByRole("heading", { name: "확인할 항목이 없습니다" });
  const buttons = screen.getAllByRole("button", { name: "기존 이미지 채점" });
  expect(buttons).toHaveLength(2);
  await user.click(buttons[1]);
  expect(api.start).toHaveBeenCalledTimes(1);
  expect(await screen.findByText(/기존 이미지 채점 3 \/ 12 · 건너뜀 2/)).toBeInTheDocument();
  for (const button of screen.getAllByRole("button", { name: "기존 이미지 채점" })) expect(button).toBeDisabled();
  await user.click(screen.getByRole("button", { name: "채점 취소" }));
  expect(api.cancel).toHaveBeenCalledTimes(1);
  expect(await screen.findByText(/취소됨/)).toBeInTheDocument();
  await waitFor(() => expect(api.page).toHaveBeenCalledTimes(2));
});

it("polls a running job after reopening and refreshes on completion", async () => {
  const api = { ...idleApi(), page: vi.fn().mockResolvedValue({ items: [], nextOffset: null, policyVersion: null, summary: emptyShadowSummary() }) };
  api.status.mockResolvedValueOnce({ ...idleStatus, running: true, total: 2 })
    .mockResolvedValue({ ...idleStatus, total: 2, scored: 1, skipped: 1 });
  render(<ShadowReview onClose={vi.fn()} api={api} />);
  expect(await screen.findByRole("button", { name: "채점 취소" })).toBeInTheDocument();
  await waitFor(() => expect(api.page).toHaveBeenCalledTimes(2), { timeout: 2500 });
  expect(screen.queryByRole("button", { name: "채점 취소" })).not.toBeInTheDocument();
});

it("shows separate origin precision and updates only the judged origin", async () => {
  const summary = emptyShadowSummary();
  summary.automatic = { pending: 1, accepted: 23, rejected: 2 };
  summary.byOrigin.backfill.automatic = { pending: 1, accepted: 18, rejected: 2 };
  summary.byOrigin.live.automatic = { pending: 0, accepted: 5, rejected: 0 };
  fixture([{ ...item("a1", "automatic", 0.12), origin: "backfill" }], summary);
  await screen.findByRole("heading", { level: 3, name: "히나" });
  expect(screen.getByLabelText("진행 상황")).toHaveTextContent("자동 후보 정확도23/25 · 기존 18/20 · 신규 5/5");
  await userEvent.setup().keyboard("d");
  await waitFor(() => expect(screen.getByLabelText("진행 상황")).toHaveTextContent("자동 후보 정확도24/26 · 기존 19/21 · 신규 5/5"));
});

it("never shows a judged candidate again when a page requested before the judgment arrives later", async () => {
  const a1 = item("a1", "automatic", 0.12), a2 = item("a2", "automatic", 0.121, "kisaki");
  const summary = { ...emptyShadowSummary(), automatic: { pending: 2, accepted: 0, rejected: 0 } };
  let resolveStale!: (page: ShadowReviewPage) => void;
  const page = vi.fn()
    .mockResolvedValueOnce({ items: [a1, a2], nextOffset: null, policyVersion: "v1", summary })
    // The reload after history scoring was requested before the judgment was stored.
    .mockImplementationOnce(() => new Promise<ShadowReviewPage>(resolve => { resolveStale = resolve; }));
  const decide = vi.fn(async () => 1);
  const api = { ...idleApi(), page, start: vi.fn().mockResolvedValue({ ...idleStatus, running: true }) };
  render(<ShadowReview onClose={vi.fn()} api={api} decisions={{ decide }} />);
  await screen.findByRole("heading", { level: 3, name: "히나" });
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "기존 이미지 채점" }));
  await waitFor(() => expect(page).toHaveBeenCalledTimes(2), { timeout: 3000 });
  await user.keyboard("{ArrowRight}");
  await screen.findByRole("heading", { level: 3, name: "키사키" });
  resolveStale({ items: [a1, a2], nextOffset: null, policyVersion: "v1", summary });
  await waitFor(() => expect(page.mock.results[1]).toBeDefined());
  await new Promise(resolve => setTimeout(resolve, 20));
  expect(screen.getByRole("heading", { level: 3, name: "키사키" })).toBeInTheDocument();
  expect(screen.queryByRole("heading", { level: 3, name: "히나" })).toBeNull();
  // The same image offered for another character says what was already decided on it.
  expect(screen.queryByRole("note")).toBeNull();
});

it("tells the reviewer when another character on the same image was already judged", async () => {
  const { decide } = fixture([item("a1", "automatic", 0.12), item("a1", "automatic", 0.125, "kisaki")]);
  await screen.findByRole("heading", { level: 3, name: "히나" });
  const user = userEvent.setup();
  await user.keyboard("{ArrowRight}");
  await waitFor(() => expect(decide).toHaveBeenCalledTimes(1));
  expect(await screen.findByRole("heading", { level: 3, name: "키사키" })).toBeInTheDocument();
  expect(screen.getByRole("note")).toHaveTextContent("앞에서 히나 맞음(으)로 판단했습니다");
});
