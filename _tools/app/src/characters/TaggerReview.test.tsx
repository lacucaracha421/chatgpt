import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { ChromeTarget, WorkspaceChromeProvider } from "../layout/WorkspaceChrome";
import type { AssetSummary, ClassificationEntry } from "../library/types";
import type { CharacterTarget } from "./api";
import { TaggerReview } from "./TaggerReview";
import type { TaggerDecisionApi, TaggerReviewItem } from "./taggerReviewClient";

afterEach(() => { cleanup(); localStorage.clear(); vi.restoreAllMocks(); });

const classifications = [
  { id: "series", parentId: null, name: "백합" },
  { id: "child", parentId: "series", name: "캐릭터 자료" },
  { id: "other", parentId: null, name: "다른 폴더" },
] as ClassificationEntry[];
const targets = [{ id: "char", seriesClassificationId: "series", displayName: "라라", thumbnailAssetId: null, references: [] }] as unknown as CharacterTarget[];

function asset(id: string): AssetSummary {
  return { id, originalName: `${id}.png`, title: null, byteSize: 1, width: 100, height: 120, collectedAt: "2026-09-27T00:00:00Z",
    favorite: false, sourceUrl: null, sourcePublishedAt: null, creatorName: null, creatorHandle: null, creatorUrl: null, importSource: null,
    importBatchId: null, originalModifiedAt: null, media: { kind: "image" } as never };
}

function item(id: string, reason: "recommendation" | "veto" = "recommendation"): TaggerReviewItem {
  return { asset: asset(id), seriesId: "series", targetId: "char", targetName: "라라", targetFingerprint: "fp-char",
    evidence: { source: "tagger", reason, pixaiScore: reason === "recommendation" ? .91 : .11, canaryScore: reason === "recommendation" ? .94 : .18 } };
}

function fixture(items: TaggerReviewItem[], folders: Record<string, string[]> = {}, privacyMode = false) {
  const api: TaggerDecisionApi = {
    decide: vi.fn(async () => 1),
    decideBatch: vi.fn(async () => 1),
    move: vi.fn(async () => 1),
    classifications: vi.fn(async (id) => folders[id] ?? ["child"]),
  };
  const onItemsChange = vi.fn(), onBack = vi.fn();
  render(<WorkspaceChromeProvider scope="tagger-test"><ChromeTarget name="navigation" />
    <TaggerReview items={items} targets={targets} classifications={classifications} privacyMode={privacyMode} api={api} onItemsChange={onItemsChange} onBack={onBack} />
  </WorkspaceChromeProvider>);
  return { api, onItemsChange, onBack };
}

async function openCharacter() {
  await userEvent.setup().click(await screen.findByRole("button", { name: "백합 › 라라 태거 검토 2건" }));
  return screen.findByRole("grid", { name: "라라 태거 후보" });
}

it("stores tile judgments as direct manual decisions", async () => {
  const { api } = fixture([item("a1"), item("a2", "veto")]);
  const grid = await openCharacter();
  await waitFor(() => expect(api.classifications).toHaveBeenCalledTimes(2));
  await userEvent.setup().click(within(grid).getByRole("button", { name: "a1.png 맞음" }));
  expect(api.decide).toHaveBeenCalledWith({
    targetId: "char", expectedFingerprint: "fp-char", assetIds: ["a1"], decision: "accepted", baselineFingerprint: null, scanId: null,
  });
  await userEvent.setup().click(within(grid).getByRole("button", { name: "a2.png 아님" }));
  expect(api.decide).toHaveBeenLastCalledWith({
    targetId: "char", expectedFingerprint: "fp-char", assetIds: ["a2"], decision: "rejected", baselineFingerprint: null, scanId: null,
  });
});

it("uses the manual batch command for 모두 맞음", async () => {
  const { api } = fixture([item("a1"), item("a2")]);
  await openCharacter();
  await waitFor(() => expect(api.classifications).toHaveBeenCalledTimes(2));
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "모두 맞음" }));
  expect(screen.getAllByRole("checkbox")).toHaveLength(2);
  await user.click(screen.getByRole("button", { name: "2건 맞음 저장" }));
  expect(api.decideBatch).toHaveBeenCalledWith([{
    targetId: "char", expectedFingerprint: "fp-char", assetIds: ["a1", "a2"], decision: "accepted", baselineFingerprint: null, scanId: null,
  }]);
});

it("marks outside-folder tiles and moves them through the explicit accept action", async () => {
  const { api } = fixture([item("a1"), item("a2")], { a1: ["other"], a2: ["child"] });
  const grid = await openCharacter();
  expect(await within(grid).findByText("폴더 밖")).toBeInTheDocument();
  await userEvent.setup().click(within(grid).getByRole("button", { name: "a1.png 맞음" }));
  expect(api.move).toHaveBeenCalledWith("char", "fp-char", ["a1"]);
  expect(api.decide).not.toHaveBeenCalledWith(expect.objectContaining({ assetIds: ["a1"] }));
});

it("moves grid focus with arrows, toggles bulk checks, and returns with Escape", async () => {
  fixture([item("a1"), item("a2")]);
  const grid = await openCharacter();
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "모두 아님" }));
  const cells = within(grid).getAllByRole("gridcell");
  cells[0].focus();
  await user.keyboard(" ");
  expect(within(cells[0]).getByRole("checkbox")).not.toBeChecked();
  await user.keyboard("{ArrowRight}");
  expect(cells[1]).toHaveFocus();
  await user.keyboard("{Escape}");
  expect(screen.queryByRole("grid", { name: "라라 태거 후보" })).not.toBeInTheDocument();
  expect(screen.getByRole("region", { name: "백합" })).toBeInTheDocument();
});

it("renders normalized crop percentages within the contained image and uses originals in preview", async () => {
  const candidate = item("a1");
  candidate.crop = { box: [.1, .2, .6, .8], distance: .234 };
  fixture([candidate, item("a2")]);
  const grid = await openCharacter();
  const box = within(grid).getByRole("img", { name: "라라 감지 영역" });
  expect(box).toHaveStyle({ left: "10%", top: "20%", width: "50%" });
  expect(parseFloat(box.style.height)).toBeCloseTo(60);
  expect(box.parentElement).toHaveStyle({ height: "100%" });
  expect(parseFloat(box.parentElement!.style.width)).toBeCloseTo(100 * 100 / 120);
  expect(within(grid).getByText("0.234")).toBeInTheDocument();
  await userEvent.setup().click(within(grid).getAllByRole("gridcell")[0]);
  const preview = screen.getByRole("region", { name: "이미지 미리보기" });
  expect(within(preview).getByAltText("a1.png — 라라 후보")).toHaveAttribute("src", "http://lakomics.localhost/asset/a1");
  expect(within(preview).getByRole("img", { name: "라라 감지 영역" })).toHaveStyle({ left: "10%" });
});

it("previews with Enter/Space, navigates with arrows, closes with Escape, and decides with A/X", async () => {
  const { api } = fixture([item("a1"), item("a2")]);
  let grid = await openCharacter();
  await waitFor(() => expect(api.classifications).toHaveBeenCalledTimes(2));
  const user = userEvent.setup();
  within(grid).getAllByRole("gridcell")[0].focus();
  await user.keyboard("{Enter}");
  expect(screen.getByRole("region", { name: "이미지 미리보기" })).toHaveFocus();
  await user.keyboard("{ArrowRight}");
  expect(screen.getByAltText("a2.png — 라라 후보")).toBeInTheDocument();
  await user.keyboard("{ArrowLeft}");
  expect(screen.getByAltText("a1.png — 라라 후보")).toBeInTheDocument();
  await user.keyboard("{Escape}");
  expect(screen.queryByRole("region", { name: "이미지 미리보기" })).not.toBeInTheDocument();
  grid = screen.getByRole("grid");
  expect(within(grid).getAllByRole("gridcell")[0]).toHaveFocus();
  await user.keyboard(" ");
  await user.keyboard("A");
  expect(api.decide).toHaveBeenCalledWith(expect.objectContaining({ assetIds: ["a1"], decision: "accepted" }));
  expect(await screen.findByAltText("a2.png — 라라 후보")).toBeInTheDocument();
  await user.keyboard("X");
  expect(api.decide).toHaveBeenLastCalledWith(expect.objectContaining({ assetIds: ["a2"], decision: "rejected" }));
  expect(screen.queryByRole("region", { name: "이미지 미리보기" })).not.toBeInTheDocument();
});

it("keeps outside-series acceptance and failed decisions on the same preview path", async () => {
  const { api } = fixture([item("a1"), item("a2")], { a1: ["other"] });
  const grid = await openCharacter();
  await within(grid).findByText("폴더 밖");
  const user = userEvent.setup();
  await user.click(within(grid).getAllByRole("gridcell")[0]);
  vi.mocked(api.move).mockRejectedValueOnce(new Error("save failed"));
  await user.keyboard("a");
  expect(await screen.findByRole("alert")).toBeInTheDocument();
  expect(screen.getByAltText("a1.png — 라라 후보")).toBeInTheDocument();
  await user.keyboard("a");
  expect(api.move).toHaveBeenLastCalledWith("char", "fp-char", ["a1"]);
  expect(await screen.findByAltText("a2.png — 라라 후보")).toBeInTheDocument();
});

it("selects all, clears, and shift-selects a range before the existing batch confirmation", async () => {
  const { api } = fixture([item("a1"), item("a2"), item("a3"), item("a4")]);
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "백합 › 라라 태거 검토 4건" }));
  await user.click(screen.getByRole("button", { name: "모두 아님" }));
  await user.click(screen.getByRole("button", { name: "선택 해제" }));
  expect(screen.getAllByRole("checkbox").every((box) => !(box as HTMLInputElement).checked)).toBe(true);
  await user.click(screen.getByRole("checkbox", { name: "a2.png 선택" }));
  await user.keyboard("{Shift>}");
  await user.click(screen.getByRole("checkbox", { name: "a4.png 선택" }));
  await user.keyboard("{/Shift}");
  expect(screen.getByRole("checkbox", { name: "a1.png 선택" })).not.toBeChecked();
  for (const id of ["a2", "a3", "a4"]) expect(screen.getByRole("checkbox", { name: `${id}.png 선택` })).toBeChecked();
  expect(api.decideBatch).not.toHaveBeenCalled();
  await user.click(screen.getByRole("button", { name: "전부 선택" }));
  expect(screen.getAllByRole("checkbox").every((box) => (box as HTMLInputElement).checked)).toBe(true);
  await user.click(screen.getByRole("button", { name: "4건 아님 저장" }));
  expect(api.decideBatch).toHaveBeenCalledWith([expect.objectContaining({ assetIds: ["a1", "a2", "a3", "a4"], decision: "rejected" })]);
});

it("remembers tile size and tolerates unavailable storage", async () => {
  fixture([item("a1"), item("a2")]);
  await openCharacter();
  expect(screen.getByRole("button", { name: "크게" })).toHaveAttribute("aria-pressed", "true");
  await userEvent.setup().click(screen.getByRole("button", { name: "작게" }));
  expect(localStorage.getItem("lakomics.taggerReview.tileSize")).toBe("small");
  cleanup();
  fixture([item("a1"), item("a2")]);
  await openCharacter();
  expect(screen.getByRole("button", { name: "작게" })).toHaveAttribute("aria-pressed", "true");
  cleanup();
  vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new Error("blocked"); });
  vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("blocked"); });
  fixture([item("a1"), item("a2")]);
  await openCharacter();
  expect(screen.getByRole("button", { name: "크게" })).toHaveAttribute("aria-pressed", "true");
});

it("renders no image or crop in privacy mode, including the preview", async () => {
  const candidate = item("a1");
  candidate.crop = { box: [.1, .2, .6, .8], distance: .234 };
  fixture([candidate, item("a2")], {}, true);
  const grid = await openCharacter();
  expect(screen.queryByRole("img")).not.toBeInTheDocument();
  await userEvent.setup().click(within(grid).getAllByRole("gridcell")[0]);
  expect(screen.getByRole("region", { name: "이미지 미리보기" })).toBeInTheDocument();
  expect(screen.queryByRole("img")).not.toBeInTheDocument();
});


it("does not reopen a preview closed during a pending decision or submit twice", async () => {
  const { api } = fixture([item("a1"), item("a2")]);
  let finish!: (count: number) => void;
  vi.mocked(api.decide).mockImplementationOnce(() => new Promise<number>((resolve) => { finish = resolve; }));
  const grid = await openCharacter();
  await waitFor(() => expect(api.classifications).toHaveBeenCalledTimes(2));
  const user = userEvent.setup();
  await user.click(within(grid).getAllByRole("gridcell")[0]);
  await user.keyboard("xx{Escape}");
  expect(api.decide).toHaveBeenCalledTimes(1);
  finish(1);
  await waitFor(() => expect(screen.queryByAltText("a1.png — 라라 후보")).not.toBeInTheDocument());
  expect(screen.queryByRole("region", { name: "이미지 미리보기" })).not.toBeInTheDocument();
});
