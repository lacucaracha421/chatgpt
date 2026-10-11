import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
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
const withBox = (id: string, targetId = "hina") => { const row = tagItem(id, "recommendation", targetId); row.crop = { box: [0.1, 0.2, 0.6, 0.8], distance: 0.3 }; return row; };
/** A grid tile: the picking button named by character and file. */
const tile = (character: string, file: string) => screen.findByRole("button", { name: `${character} · ${file}` });
const applyButton = (name: string | RegExp) => screen.getByRole("button", { name });
/** Open the apply confirmation and press its button. */
async function confirmApply(user: ReturnType<typeof userEvent.setup>, label: string | RegExp) {
  await user.click(applyButton(label));
  const ask = await screen.findByRole("dialog", { name: label });
  await user.click(within(ask).getByRole("button", { name: "적용" }));
}

it("lists the three kinds in one grid, each tile labelled in plain words, with a count per kind", async () => {
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
  // Two characters: a header per character, with the name, the count and the references.
  const hina = within(await screen.findByRole("region", { name: "히나" }));
  expect(hina.getByRole("heading", { level: 3, name: "히나" })).toBeInTheDocument();
  expect(hina.getByRole("list", { name: "히나 레퍼런스" }).querySelectorAll("img")).toHaveLength(2);
  expect(hina.getByText("인식 추천")).toBeInTheDocument();
  expect(hina.getByText("태그 추천")).toBeInTheDocument();
  expect(hina.getByText("자동 태그 확실")).toBeInTheDocument();
  const kisaki = within(screen.getByRole("region", { name: "키사키" }));
  expect(kisaki.getAllByText("다시 확인")).toHaveLength(2);
  expect(kisaki.getByText("자동 태그가 이 이름을 읽지 않음")).toBeInTheDocument();
  expect(kisaki.getByText("학습 인식이 지지하지 않음")).toBeInTheDocument();
  const retired = /PixAI|canary|B36|S36|knn|태거/i;
  expect(document.body.textContent).not.toMatch(retired);
  document.querySelectorAll("[aria-label], [title], [aria-description], img[alt]").forEach(element => {
    for (const name of ["aria-label", "title", "aria-description", "alt"]) expect(element.getAttribute(name) ?? "").not.toMatch(retired);
  });
});

it("shows no character header when the grid holds a single character", async () => {
  fixture({ candidates: [shadowItem("c1", "hina", "히나"), shadowItem("c2", "hina", "히나")] });
  await tile("히나", "c1.png");
  expect(screen.queryByRole("heading", { level: 3 })).not.toBeInTheDocument();
});

it("filters by kind and falls back to all when the chosen kind runs out", async () => {
  const { decisions } = fixture({ tags: [tagItem("t1")], candidates: [shadowItem("c1", "hina", "히나")] });
  const user = userEvent.setup();
  await user.click(await screen.findByRole("tab", { name: /태그 추천\s*1/ }));
  expect(screen.queryByRole("button", { name: "히나 · c1.png" })).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "히나 · t1.png" })).toBeInTheDocument();
  expect(screen.getByText("자동 태그 확실")).toBeInTheDocument();
  await confirmApply(user, "모두 맞음");
  await waitFor(() => expect(decisions.decideBatch).toHaveBeenCalledWith([request("hina", "t1", "accepted")]));
  await waitFor(() => expect(screen.getByRole("tab", { name: /전체\s*1/ })).toHaveAttribute("aria-selected", "true"));
  expect(screen.queryByRole("tab", { name: /태그 추천/ })).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "히나 · c1.png" })).toBeInTheDocument();
});

it("shows an image both the tags and the recognition bring up once, with both reasons", async () => {
  fixture({ tags: [tagItem("x1", "recommendation", "hina", [0.9, 0.6])], candidates: [shadowItem("x1", "hina", "히나")] });
  await tile("히나", "x1.png");
  const badges = within(document.querySelector<HTMLElement>(".confirm-grid__badges")!);
  expect(badges.getByText("인식 추천")).toBeInTheDocument();
  expect(badges.getByText("태그 추천")).toBeInTheDocument();
  expect(badges.getByText("자동 태그 불확실")).toBeInTheDocument();
  expect(screen.getByRole("tab", { name: /전체\s*1/ })).toBeInTheDocument();
});

it("marks and unmarks a tile 아님 and counts the marks", async () => {
  fixture({ candidates: [shadowItem("c1", "hina", "히나"), shadowItem("c2", "hina", "히나")] });
  const user = userEvent.setup();
  const first = await tile("히나", "c1.png");
  expect(first).toHaveAttribute("aria-pressed", "false");
  expect(screen.getByText(/표시됨/)).toHaveTextContent("아님 0장 표시됨");
  expect(screen.getByRole("button", { name: "표시 모두 지우기" })).toBeDisabled();
  expect(applyButton("모두 맞음")).toBeInTheDocument();

  await user.click(first);
  expect(first).toHaveAttribute("aria-pressed", "true");
  expect(within(first).getByText("아님")).toBeInTheDocument();
  expect(screen.getByText(/표시됨/)).toHaveTextContent("아님 1장 표시됨");
  expect(applyButton("아님 1장 빼고 나머지 맞음")).toBeEnabled();

  await user.click(first);
  expect(first).toHaveAttribute("aria-pressed", "false");
  expect(screen.getByText(/표시됨/)).toHaveTextContent("아님 0장 표시됨");

  // Space and Enter on a focused tile toggle it too; 표시 모두 지우기 clears every mark.
  first.focus();
  await user.keyboard(" ");
  expect(first).toHaveAttribute("aria-pressed", "true");
  await user.click(await tile("히나", "c2.png"));
  expect(screen.getByText(/표시됨/)).toHaveTextContent("아님 2장 표시됨");
  await user.click(screen.getByRole("button", { name: "표시 모두 지우기" }));
  expect(screen.getByText(/표시됨/)).toHaveTextContent("아님 0장 표시됨");
  expect(first).toHaveAttribute("aria-pressed", "false");
});

it("selects a range with shift-click in the order the grid shows", async () => {
  fixture({ candidates: [shadowItem("c1", "hina", "히나"), shadowItem("c2", "kisaki", "키사키"), shadowItem("c3", "hina", "히나"), shadowItem("c4", "hina", "히나")] });
  const user = userEvent.setup();
  // The grid groups by character: 히나 c1, c3, c4, then 키사키 c2.
  await user.click(await tile("히나", "c1.png"));
  await user.keyboard("{Shift>}");
  await user.click(await tile("히나", "c4.png"));
  await user.keyboard("{/Shift}");
  expect(screen.getByText(/표시됨/)).toHaveTextContent("아님 3장 표시됨");
  expect(await tile("히나", "c3.png")).toHaveAttribute("aria-pressed", "true");
  expect(await tile("키사키", "c2.png")).toHaveAttribute("aria-pressed", "false");
  // A shift-click on a marked tile clears the range back to the anchor (c4 → c3).
  await user.keyboard("{Shift>}");
  await user.click(await tile("히나", "c3.png"));
  await user.keyboard("{/Shift}");
  expect(screen.getByText(/표시됨/)).toHaveTextContent("아님 1장 표시됨");
  expect(await tile("히나", "c1.png")).toHaveAttribute("aria-pressed", "true");
});

it("applies 아님 to the marked and 맞음 to the rest, only after the in-app confirmation", async () => {
  const { decisions, onChanged } = fixture({
    candidates: [shadowItem("c1", "hina", "히나"), shadowItem("c2", "kisaki", "키사키"), shadowItem("c3", "hina", "히나")],
    tags: [tagItem("t1")],
  });
  const user = userEvent.setup();
  await user.click(await tile("키사키", "c2.png"));
  await user.click(await tile("히나", "c3.png"));
  expect(document.querySelector(".confirm-list__apply-sum")).toHaveTextContent("맞음 2장 · 아님 2장");
  await user.click(applyButton("아님 2장 빼고 나머지 맞음"));
  const ask = await screen.findByRole("dialog", { name: "아님 2장 빼고 나머지 맞음" });
  expect(within(ask).getByText("맞음 2장, 아님 2장을 저장할까요?")).toBeInTheDocument();
  expect(decisions.decideBatch).not.toHaveBeenCalled();
  await user.click(within(ask).getByRole("button", { name: "취소" }));
  expect(decisions.decideBatch).not.toHaveBeenCalled();
  expect(screen.getByRole("tab", { name: /전체\s*4/ })).toBeInTheDocument();

  await confirmApply(user, "아님 2장 빼고 나머지 맞음");
  await waitFor(() => expect(decisions.decideBatch).toHaveBeenCalledTimes(1));
  const sent = vi.mocked(decisions.decideBatch).mock.calls[0]![0];
  expect(sent).toHaveLength(4);
  expect(sent).toEqual(expect.arrayContaining([
    request("hina", "c1", "accepted"), request("hina", "t1", "accepted"), request("kisaki", "c2", "rejected"), request("hina", "c3", "rejected"),
  ]));
  expect(decisions.decide).not.toHaveBeenCalled();
  expect(decisions.move).not.toHaveBeenCalled();
  expect(await screen.findByRole("heading", { name: "확인할 항목이 없습니다" })).toBeInTheDocument();
  expect(screen.getByText(/맞음 2장, 아님 2장을 처리했습니다\. 한 번에 되돌릴 수는 없습니다/)).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: /되돌리기/ })).not.toBeInTheDocument();
  expect(onChanged).toHaveBeenCalledTimes(1);
});

it("has one apply button at the bottom and no 모두 맞음 button in the header", async () => {
  fixture({ candidates: [shadowItem("c1", "hina", "히나"), shadowItem("c2", "hina", "히나")] });
  await tile("히나", "c1.png");
  const apply = screen.getAllByRole("button", { name: "모두 맞음" });
  expect(apply).toHaveLength(1);
  expect(apply[0]!.closest("header.confirm-list__header")).toBeNull();
  expect(apply[0]!.closest("footer.confirm-list__apply")).not.toBeNull();
});

it("says 모두 맞음 for an unmarked grid and stores 맞음 for everything shown", async () => {
  const { decisions } = fixture({ candidates: [shadowItem("c1", "hina", "히나"), shadowItem("c2", "kisaki", "키사키")] });
  const user = userEvent.setup();
  await tile("히나", "c1.png");
  await user.click(applyButton("모두 맞음"));
  expect(within(await screen.findByRole("dialog", { name: "모두 맞음" })).getByText("2장을 모두 맞음으로 처리할까요?")).toBeInTheDocument();
  await user.click(within(screen.getByRole("dialog", { name: "모두 맞음" })).getByRole("button", { name: "적용" }));
  await waitFor(() => expect(decisions.decideBatch).toHaveBeenCalledWith(expect.arrayContaining([request("hina", "c1", "accepted"), request("kisaki", "c2", "accepted")])));
  expect(await screen.findByText(/2장을 맞음으로 처리했습니다\. 한 번에 되돌릴 수는 없습니다/)).toBeInTheDocument();
});

it("applies only the active kind tab, moving a tag item outside the series in and rejecting without a move", async () => {
  const { decisions } = fixture({ tags: [tagItem("o1"), tagItem("t2"), tagItem("o3")], candidates: [shadowItem("c1", "hina", "히나")], folders: { o1: ["other"], o3: ["other"] } });
  const user = userEvent.setup();
  await user.click(await screen.findByRole("tab", { name: /태그 추천\s*3/ }));
  await user.click(await tile("히나", "o3.png"));
  await confirmApply(user, "아님 1장 빼고 나머지 맞음");
  await waitFor(() => expect(decisions.move).toHaveBeenCalledWith("hina", "fp-hina", ["o1"], true));
  expect(decisions.move).toHaveBeenCalledTimes(1);
  await waitFor(() => expect(decisions.decideBatch).toHaveBeenCalledWith(expect.arrayContaining([request("hina", "t2", "accepted"), request("hina", "o3", "rejected")])));
  expect(vi.mocked(decisions.decideBatch).mock.calls[0]![0]).toHaveLength(2);
  expect(await screen.findByRole("button", { name: "히나 · c1.png" })).toBeInTheDocument();
  expect(screen.getByRole("tab", { name: /전체\s*1/ })).toBeInTheDocument();
});

it("keeps the items that failed in the grid, still marked, names them and updates the counts", async () => {
  const { decisions } = fixture({ candidates: [shadowItem("c1", "hina", "히나"), shadowItem("c2", "kisaki", "키사키"), shadowItem("c3", "hina", "히나")] });
  vi.mocked(decisions.decideBatch).mockRejectedValueOnce(new Error("batch down"));
  vi.mocked(decisions.decide).mockImplementation(async request => {
    if (request.assetIds[0] === "c2") throw { code: "invalid_character_request", message: "시리즈 폴더 안의 지원되는 자산을 선택해 주세요." };
    return 1;
  });
  const user = userEvent.setup();
  await user.click(await tile("키사키", "c2.png"));
  await confirmApply(user, "아님 1장 빼고 나머지 맞음");
  const notice = await screen.findByText(/2장을 맞음으로 처리했습니다/);
  expect(notice).toHaveTextContent("1장은 저장하지 못해 목록에 남겼습니다: 키사키 · c2.png");
  expect(notice).toHaveTextContent("시리즈 폴더 안의 지원되는 자산을 선택해 주세요.");
  expect(decisions.decide).toHaveBeenCalledTimes(3);
  const stays = await tile("키사키", "c2.png");
  expect(stays).toHaveAttribute("aria-pressed", "true");
  expect(screen.queryByRole("button", { name: /^히나 · / })).not.toBeInTheDocument();
  expect(screen.getByRole("tab", { name: /전체\s*1/ })).toBeInTheDocument();
  expect(screen.getByRole("dialog", { name: "확인" })).toHaveTextContent(/남은 항목\s*1/);
  expect(screen.getByText(/표시됨/)).toHaveTextContent("아님 1장 표시됨");
});

it("leaves an image with a person box out of the bulk action and asks for a single look", async () => {
  const { decisions } = fixture({ tags: [withBox("w1"), tagItem("w2"), tagItem("w3")] });
  const user = userEvent.setup();
  const boxed = await screen.findByRole("button", { name: /^히나 · w1\.png · 한 장씩 보기 필요/ });
  expect(boxed).not.toHaveAttribute("aria-pressed");
  expect(screen.getAllByText("한 장씩 보기 필요").length).toBeGreaterThan(0);
  expect(document.querySelector(".confirm-list__marks-single")).toHaveTextContent("한 장씩 보기 필요 1장");
  // A click on it opens the single view instead of marking it.
  await user.click(boxed);
  expect(await screen.findByRole("img", { name: "히나 감지 영역" })).toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: /목록으로/ }));
  await user.click(await tile("히나", "w3.png"));
  expect(screen.getByText(/표시됨/)).toHaveTextContent("아님 1장 표시됨");
  await user.click(applyButton("아님 1장 빼고 나머지 맞음"));
  const ask = await screen.findByRole("dialog", { name: "아님 1장 빼고 나머지 맞음" });
  expect(within(ask).getByText("맞음 1장, 아님 1장을 저장할까요?")).toBeInTheDocument();
  expect(within(ask).getByText("한 장씩 보기 필요 1장은 그대로 둡니다.")).toBeInTheDocument();
  await user.click(within(ask).getByRole("button", { name: "적용" }));
  await waitFor(() => expect(decisions.decideBatch).toHaveBeenCalledTimes(1));
  expect(vi.mocked(decisions.decideBatch).mock.calls[0]![0]).toEqual(expect.arrayContaining([request("hina", "w2", "accepted"), request("hina", "w3", "rejected")]));
  expect(vi.mocked(decisions.decideBatch).mock.calls[0]![0]).toHaveLength(2);
  // The boxed image is still waiting.
  expect(await screen.findByRole("button", { name: /^히나 · w1\.png · 한 장씩/ })).toBeInTheDocument();
  expect(applyButton("모두 맞음")).toBeDisabled();
});

it("opens one image alone by double click or the magnifier, and returns to the grid with the marks kept", async () => {
  const { decisions } = fixture({ candidates: [shadowItem("c1", "hina", "히나"), shadowItem("c2", "kisaki", "키사키"), shadowItem("c3", "kisaki", "키사키")] });
  const user = userEvent.setup();
  await user.click(await tile("히나", "c1.png"));
  await user.dblClick(await tile("키사키", "c2.png"));
  // The double click opened the image without changing its mark.
  const panel = await screen.findByLabelText("확인 정보");
  expect(within(panel).getByRole("heading", { level: 3, name: "키사키?" })).toBeInTheDocument();
  expect(within(panel).getByText("c2.png")).toBeInTheDocument();
  expect(screen.queryByText(/표시됨/)).not.toBeInTheDocument();
  await user.click(within(panel).getByRole("button", { name: /목록으로/ }));
  expect(await tile("히나", "c1.png")).toHaveAttribute("aria-pressed", "true");
  expect(await tile("키사키", "c2.png")).toHaveAttribute("aria-pressed", "false");
  expect(screen.getByText(/표시됨/)).toHaveTextContent("아님 1장 표시됨");

  await user.click(screen.getByRole("button", { name: "키사키 · c3.png 크게 보기" }));
  expect(await screen.findByRole("heading", { level: 3, name: "키사키?" })).toBeInTheDocument();
  expect(screen.getByText("c3.png")).toBeInTheDocument();
  await user.keyboard("{ArrowRight}");
  await waitFor(() => expect(decisions.decide).toHaveBeenCalledWith(request("kisaki", "c3", "accepted")));
  // On to the next image in the grid's order, not back to the grid.
  expect(await screen.findByText("c1.png")).toBeInTheDocument();
});

it("stores 맞음 and 아님 from the single view as direct decisions, with keyboard shortcuts", async () => {
  const { decisions, onChanged } = fixture({ candidates: [shadowItem("c1", "hina", "히나"), shadowItem("c2", "kisaki", "키사키", { verdict: "recommended" })] });
  const user = userEvent.setup();
  await user.click(await screen.findByRole("button", { name: "히나 · c1.png 크게 보기" }));
  await screen.findByRole("heading", { level: 3, name: "히나?" });
  await user.keyboard("{ArrowRight}");
  await waitFor(() => expect(decisions.decide).toHaveBeenCalledWith(request("hina", "c1", "accepted")));
  expect(await screen.findByRole("heading", { level: 3, name: "키사키?" })).toBeInTheDocument();
  expect(onChanged).toHaveBeenCalledTimes(1);
  await user.keyboard("a");
  await waitFor(() => expect(decisions.decide).toHaveBeenLastCalledWith(request("kisaki", "c2", "rejected")));
  expect(await screen.findByRole("heading", { name: "확인할 항목이 없습니다" })).toBeInTheDocument();
  expect(decisions.move).not.toHaveBeenCalled();
});

it("keeps 맞음 · 위치 틀림 for images that carry a person box, and stores it as membership only", async () => {
  const { decisions } = fixture({ tags: [withBox("w1"), tagItem("w2")] });
  const user = userEvent.setup();
  await user.click(await screen.findByRole("button", { name: /^히나 · w1\.png · 한 장씩 보기 필요/ }));
  expect(await screen.findByRole("img", { name: "히나 감지 영역" })).toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: /맞음 · 위치 틀림/ }));
  await waitFor(() => expect(decisions.decide).toHaveBeenCalledWith(request("hina", "w1", "accepted_wrong_region")));
  // The next image has no box: the action is not offered.
  expect(await screen.findByText("w2.png")).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: /^맞음 · 위치 틀림/ })).not.toBeInTheDocument();
});

it("moves a tag-listed image outside the series in when judged 맞음 alone, and cannot undo that", async () => {
  const { decisions } = fixture({ tags: [tagItem("o1")], folders: { o1: ["other"] } });
  const user = userEvent.setup();
  await user.click(await screen.findByRole("button", { name: "히나 · o1.png 크게 보기" }));
  expect(await screen.findByText(/폴더 밖/)).toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: /^맞음/ }));
  await waitFor(() => expect(decisions.move).toHaveBeenCalledWith("hina", "fp-hina", ["o1"], true));
  expect(decisions.decide).not.toHaveBeenCalled();
  expect(await screen.findByRole("heading", { name: "확인할 항목이 없습니다" })).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: /되돌리기/ })).not.toBeInTheDocument();
});

it("rejects alone without moving, even outside the series", async () => {
  const { decisions } = fixture({ tags: [tagItem("o2")], folders: { o2: ["other"] } });
  const user = userEvent.setup();
  await user.click(await screen.findByRole("button", { name: "히나 · o2.png 크게 보기" }));
  await user.click(await screen.findByRole("button", { name: /^아님/ }));
  await waitFor(() => expect(decisions.decide).toHaveBeenCalledWith(request("hina", "o2", "rejected")));
  expect(decisions.move).not.toHaveBeenCalled();
});

it("skips to the next image in the single view and undoes the last judgment", async () => {
  const { decisions } = fixture({ candidates: [shadowItem("c1", "hina", "히나"), shadowItem("c2", "hina", "히나")] });
  const user = userEvent.setup();
  await user.click(await screen.findByRole("button", { name: "히나 · c1.png 크게 보기" }));
  await user.click(await screen.findByRole("button", { name: /건너뛰기/ }));
  expect(decisions.decide).not.toHaveBeenCalled();
  expect(screen.getByLabelText("확인 정보")).toHaveTextContent("c2.png");
  await user.click(screen.getByRole("button", { name: /^맞음/ }));
  await waitFor(() => expect(decisions.decide).toHaveBeenCalledWith(request("hina", "c2", "accepted")));
  await user.click(await screen.findByRole("button", { name: /되돌리기: 히나 맞음/ }));
  await waitFor(() => expect(decisions.decide).toHaveBeenLastCalledWith(request("hina", "c2", "cleared")));
  expect(await screen.findByRole("button", { name: "히나 · c2.png" })).toBeInTheDocument();
});

it("keeps the item and shows the native error when a single judgment is refused", async () => {
  const { decisions } = fixture({ candidates: [shadowItem("c1", "hina", "히나")] });
  vi.mocked(decisions.decide).mockRejectedValueOnce({ code: "invalid_character_request", message: "시리즈 폴더 안의 지원되는 자산을 선택해 주세요." });
  const user = userEvent.setup();
  await user.click(await screen.findByRole("button", { name: "히나 · c1.png 크게 보기" }));
  await user.click(await screen.findByRole("button", { name: /^맞음/ }));
  expect(await screen.findByRole("alert")).toHaveTextContent("시리즈 폴더 안의 지원되는 자산을 선택해 주세요.");
  expect(screen.getByText("c1.png")).toBeInTheDocument();
});

it("limits both the list and its reads to the scope", async () => {
  const { sources } = fixture({
    tags: [tagItem("t1"), tagItem("t2", "recommendation", "kisaki")],
    candidates: [shadowItem("c1", "hina", "히나"), shadowItem("c2", "kisaki", "키사키")],
  }, { series: { id: "series", name: "백합" }, target: { id: "kisaki", name: "키사키" } });
  await tile("키사키", "c2.png");
  expect(screen.queryByRole("button", { name: /^히나 · / })).not.toBeInTheDocument();
  expect(screen.getByRole("tab", { name: /전체\s*2/ })).toBeInTheDocument();
  expect(screen.getByText("백합 › 키사키")).toHaveClass("confirm-list__scope");
  expect(sources.shadow.page).toHaveBeenCalledWith(expect.objectContaining({ seriesId: "series" }));
});

it("lists what could be read and says which list could not", async () => {
  const sources = confirmSourceFor({ candidates: [shadowItem("c1", "hina", "히나")] });
  sources.tagger.mockRejectedValue(new Error("down"));
  render(<ConfirmList sources={sources} targets={targets} classifications={classifications} onClose={vi.fn()} />);
  await tile("히나", "c1.png");
  expect(screen.getByText(/태그 추천 목록을 읽지 못했습니다/)).toBeInTheDocument();
});

it("shows the empty state, without an apply button, when nothing waits", async () => {
  fixture();
  expect(await screen.findByRole("heading", { name: "확인할 항목이 없습니다" })).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "모두 맞음" })).not.toBeInTheDocument();
});

it("ignores clicks on tiles while the apply is running", async () => {
  const { decisions } = fixture({ candidates: [shadowItem("c1", "hina", "히나"), shadowItem("c2", "hina", "히나")] });
  let finish: () => void = () => undefined;
  vi.mocked(decisions.decideBatch).mockImplementation(() => new Promise<number>(resolve => { finish = () => resolve(1); }));
  const user = userEvent.setup();
  await tile("히나", "c1.png");
  await user.click(applyButton("모두 맞음"));
  await user.click(within(await screen.findByRole("dialog", { name: "모두 맞음" })).getByRole("button", { name: "적용" }));
  await waitFor(() => expect(decisions.decideBatch).toHaveBeenCalled());
  // The dialog above hides the grid from the accessibility tree; the tile is still in the page.
  fireEvent.click(screen.getByRole("button", { name: "히나 · c1.png", hidden: true }));
  expect(screen.getByText(/표시됨/)).toHaveTextContent("아님 0장 표시됨");
  finish();
  expect(await screen.findByRole("heading", { name: "확인할 항목이 없습니다" })).toBeInTheDocument();
});
