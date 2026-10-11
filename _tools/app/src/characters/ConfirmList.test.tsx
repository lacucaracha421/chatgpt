import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import type { AssetSummary, ClassificationEntry } from "../library/types";
import type { CharacterTarget } from "./api";
import { ConfirmList } from "./ConfirmList";
import { confirmSourceFor, shadowItem } from "./confirmTestKit";
import type { ConfirmScope } from "./confirmClient";
import type { TaggerDecisionApi, TaggerReviewItem } from "./taggerReviewClient";

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

const classifications = [
  { id: "series", parentId: null, name: "백합" },
  { id: "child", parentId: "series", name: "캐릭터 자료" },
  { id: "other", parentId: null, name: "다른 폴더" },
] as ClassificationEntry[];
const target = (id: string, name: string, references: string[] = []) => ({ id, seriesClassificationId: "series", displayName: name, thumbnailAssetId: null, enabled: true, manualOnly: false,
  references: references.map((assetId, slot) => ({ slot, assetId, assetHash: `h-${assetId}`, status: "ready" })) }) as unknown as CharacterTarget;
const targets = [target("hina", "히나", ["r1", "r2"]), target("kisaki", "키사키")];

function asset(id: string): AssetSummary {
  return { id, originalName: `${id}.png`, title: null, byteSize: 1, width: 100, height: 120, collectedAt: "2026-09-27T00:00:00Z",
    favorite: false, sourceUrl: null, sourcePublishedAt: null, creatorName: null, creatorHandle: null, creatorUrl: null, importSource: null,
    importBatchId: null, originalModifiedAt: null, media: { kind: "image" } as never };
}
function tagItem(id: string, reason: "recommendation" | "veto" = "recommendation", targetId = "hina", scores: [number, number] = [0.91, 0.94]): TaggerReviewItem {
  return { asset: asset(id), seriesId: "series", targetId, targetName: targetId === "hina" ? "히나" : "키사키", targetFingerprint: `fp-${targetId}`,
    evidence: { source: "tagger", reason, pixaiScore: scores[0], canaryScore: scores[1] } };
}

function fixture(lists: { tags?: TaggerReviewItem[]; candidates?: ReturnType<typeof shadowItem>[]; doubtful?: ReturnType<typeof shadowItem>[]; folders?: Record<string, string[]> } = {}, scope?: ConfirmScope) {
  const sources = confirmSourceFor({ tagger: async () => lists.tags ?? [], candidates: lists.candidates, doubtful: lists.doubtful });
  const decisions: TaggerDecisionApi = {
    decide: vi.fn(async () => 1), decideBatch: vi.fn(async () => 1), move: vi.fn(async () => 1),
    classifications: vi.fn(async (id: string) => lists.folders?.[id] ?? ["child"]),
  };
  const onClose = vi.fn(), onChanged = vi.fn();
  render(<ConfirmList sources={sources} decisions={decisions} targets={targets} classifications={classifications} scope={scope} onClose={onClose} onChanged={onChanged} />);
  return { sources, decisions, onClose, onChanged };
}
const request = (targetId: string, assetId: string, decision: string) => ({ targetId, expectedFingerprint: `fp-${targetId}`, assetIds: [assetId], decision, baselineFingerprint: null, scanId: null });

it("lists the three kinds in one list, each item labelled in plain words, with a count per kind", async () => {
  fixture({
    tags: [tagItem("t1"), tagItem("t2", "veto", "kisaki", [0.12, 0.1])],
    candidates: [shadowItem("c1", "hina", "히나", { referenceAssetIds: ["r1", "r2"] })],
    doubtful: [shadowItem("d1", "kisaki", "키사키", { verdict: "none", nativeOutcome: "accepted_automatic" })],
  });
  const dialog = await screen.findByRole("dialog", { name: "확인" });
  const tabs = within(within(dialog).getByRole("tablist", { name: "확인 종류" }));
  expect(tabs.getByRole("tab", { name: /전체\s*4/ })).toBeInTheDocument();
  expect(tabs.getByRole("tab", { name: /인식 추천\s*1/ })).toBeInTheDocument();
  expect(tabs.getByRole("tab", { name: /태그 추천\s*1/ })).toBeInTheDocument();
  expect(tabs.getByRole("tab", { name: /다시 확인\s*2/ })).toBeInTheDocument();
  expect(dialog).toHaveTextContent(/남은 항목\s*4/);
  // 인식 추천 first, then 태그 추천, then 다시 확인.
  const panel = within(dialog).getByLabelText("확인 정보");
  expect(within(panel).getByRole("heading", { level: 3, name: "히나?" })).toBeInTheDocument();
  expect(within(panel).getByText("인식 추천")).toBeInTheDocument();
  expect(within(panel).getByRole("list", { name: "히나 레퍼런스" }).querySelectorAll("img")).toHaveLength(2);
  const retired = /PixAI|canary|B36|S36|knn|태거/i;
  expect(document.body.textContent).not.toMatch(retired);
  document.querySelectorAll("[aria-label], [title], [aria-description], img[alt]").forEach(element => {
    for (const name of ["aria-label", "title", "aria-description", "alt"]) expect(element.getAttribute(name) ?? "").not.toMatch(retired);
  });
});

it("filters by kind and falls back to all when the chosen kind runs out", async () => {
  fixture({ tags: [tagItem("t1")], candidates: [shadowItem("c1", "hina", "히나")] });
  const user = userEvent.setup();
  await user.click(await screen.findByRole("tab", { name: /태그 추천\s*1/ }));
  const panel = screen.getByLabelText("확인 정보");
  expect(within(panel).getByText("태그 추천")).toBeInTheDocument();
  expect(within(panel).getByText("자동 태그 확실")).toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: /맞음/ }));
  await waitFor(() => expect(screen.getByRole("tab", { name: /전체\s*1/ })).toHaveAttribute("aria-selected", "true"));
  expect(screen.queryByRole("tab", { name: /태그 추천/ })).not.toBeInTheDocument();
  expect(within(screen.getByLabelText("확인 정보")).getByText("인식 추천")).toBeInTheDocument();
});

it("shows an image both the tags and the recognition bring up once, with both reasons", async () => {
  fixture({ tags: [tagItem("x1", "recommendation", "hina", [0.9, 0.6])], candidates: [shadowItem("x1", "hina", "히나")] });
  const panel = await screen.findByLabelText("확인 정보");
  expect(within(panel).getByText("인식 추천")).toBeInTheDocument();
  expect(within(panel).getByText("태그 추천")).toBeInTheDocument();
  expect(within(panel).getByText("자동 태그 불확실")).toBeInTheDocument();
  expect(screen.getByRole("tab", { name: /전체\s*1/ })).toBeInTheDocument();
});

it("stores 맞음 and 아님 as direct manual decisions and moves on, with keyboard shortcuts", async () => {
  const { decisions, onChanged } = fixture({ candidates: [shadowItem("c1", "hina", "히나"), shadowItem("c2", "kisaki", "키사키", { verdict: "recommended" })] });
  await screen.findByRole("heading", { level: 3, name: "히나?" });
  const user = userEvent.setup();
  await user.keyboard("{ArrowRight}");
  await waitFor(() => expect(decisions.decide).toHaveBeenCalledWith(request("hina", "c1", "accepted")));
  expect(await screen.findByRole("heading", { level: 3, name: "키사키?" })).toBeInTheDocument();
  expect(onChanged).toHaveBeenCalledTimes(1);
  await user.keyboard("a");
  await waitFor(() => expect(decisions.decide).toHaveBeenLastCalledWith(request("kisaki", "c2", "rejected")));
  expect(await screen.findByRole("heading", { name: "확인할 항목이 없습니다" })).toBeInTheDocument();
  // Every judgment is the one ordinary manual decision; nothing is moved for an image already in the series.
  expect(decisions.move).not.toHaveBeenCalled();
});

it("keeps 맞음 · 위치 틀림 for tag items that carry a person box, and stores it as membership only", async () => {
  const withBox = tagItem("w1");
  withBox.crop = { box: [0.1, 0.2, 0.6, 0.8], distance: 0.3 };
  const { decisions } = fixture({ tags: [withBox, tagItem("w2")] });
  const user = userEvent.setup();
  expect(await screen.findByRole("img", { name: "히나 감지 영역" })).toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: /맞음 · 위치 틀림/ }));
  await waitFor(() => expect(decisions.decide).toHaveBeenCalledWith(request("hina", "w1", "accepted_wrong_region")));
  // The next item has no box: the action is not offered.
  expect(await screen.findByText("w2.png")).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: /^맞음 · 위치 틀림/ })).not.toBeInTheDocument();
});

it("moves a tag-listed image outside the series in when judged 맞음, and cannot undo that", async () => {
  const { decisions } = fixture({ tags: [tagItem("o1")], folders: { o1: ["other"] } });
  expect(await screen.findByText(/폴더 밖/)).toBeInTheDocument();
  await userEvent.setup().click(screen.getByRole("button", { name: /맞음/ }));
  await waitFor(() => expect(decisions.move).toHaveBeenCalledWith("hina", "fp-hina", ["o1"], true));
  expect(decisions.decide).not.toHaveBeenCalled();
  expect(await screen.findByRole("heading", { name: "확인할 항목이 없습니다" })).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: /되돌리기/ })).not.toBeInTheDocument();
});

it("rejects without moving, even outside the series", async () => {
  const { decisions } = fixture({ tags: [tagItem("o2")], folders: { o2: ["other"] } });
  await userEvent.setup().click(await screen.findByRole("button", { name: /아님/ }));
  await waitFor(() => expect(decisions.decide).toHaveBeenCalledWith(request("hina", "o2", "rejected")));
  expect(decisions.move).not.toHaveBeenCalled();
});

it("skips, offers the skipped items again, and undoes the last judgment", async () => {
  const { decisions } = fixture({ candidates: [shadowItem("c1", "hina", "히나"), shadowItem("c2", "hina", "히나")] });
  const user = userEvent.setup();
  await user.click(await screen.findByRole("button", { name: /건너뛰기/ }));
  expect(decisions.decide).not.toHaveBeenCalled();
  expect(screen.getByText("c2.png")).toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: /맞음/ }));
  expect(await screen.findByRole("heading", { name: "건너뛴 항목만 남았습니다" })).toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: /되돌리기: 히나 맞음/ }));
  await waitFor(() => expect(decisions.decide).toHaveBeenLastCalledWith(request("hina", "c2", "cleared")));
  expect(await screen.findByText("c2.png")).toBeInTheDocument();
});

it("keeps the item and shows the native error when a judgment is refused", async () => {
  const { decisions } = fixture({ candidates: [shadowItem("c1", "hina", "히나")] });
  vi.mocked(decisions.decide).mockRejectedValueOnce({ code: "invalid_character_request", message: "시리즈 폴더 안의 지원되는 자산을 선택해 주세요." });
  await userEvent.setup().click(await screen.findByRole("button", { name: /맞음/ }));
  expect(await screen.findByRole("alert")).toHaveTextContent("시리즈 폴더 안의 지원되는 자산을 선택해 주세요.");
  expect(screen.getByText("c1.png")).toBeInTheDocument();
});

it("limits both the list and its reads to the scope", async () => {
  const { sources } = fixture({
    tags: [tagItem("t1"), tagItem("t2", "recommendation", "kisaki")],
    candidates: [shadowItem("c1", "hina", "히나"), shadowItem("c2", "kisaki", "키사키")],
  }, { series: { id: "series", name: "백합" }, target: { id: "kisaki", name: "키사키" } });
  expect(await screen.findByRole("heading", { level: 3, name: "키사키?" })).toBeInTheDocument();
  expect(screen.getByRole("tab", { name: /전체\s*2/ })).toBeInTheDocument();
  expect(screen.getByText("백합 › 키사키")).toHaveClass("confirm-list__scope");
  expect(sources.shadow.page).toHaveBeenCalledWith(expect.objectContaining({ seriesId: "series" }));
});

it("lists what could be read and says which list could not", async () => {
  const sources = confirmSourceFor({ candidates: [shadowItem("c1", "hina", "히나")] });
  sources.tagger.mockRejectedValue(new Error("down"));
  render(<ConfirmList sources={sources} targets={targets} classifications={classifications} onClose={vi.fn()} />);
  expect(await screen.findByRole("heading", { level: 3, name: "히나?" })).toBeInTheDocument();
  expect(screen.getByText(/태그 추천 목록을 읽지 못했습니다/)).toBeInTheDocument();
});

it("shows the empty state when nothing waits", async () => {
  fixture();
  expect(await screen.findByRole("heading", { name: "확인할 항목이 없습니다" })).toBeInTheDocument();
});
