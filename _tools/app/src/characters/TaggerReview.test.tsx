import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { ChromeTarget, WorkspaceChromeProvider } from "../layout/WorkspaceChrome";
import type { AssetSummary, ClassificationEntry } from "../library/types";
import type { CharacterTarget } from "./api";
import { TaggerReview } from "./TaggerReview";
import type { TaggerDecisionApi, TaggerReviewItem } from "./taggerReviewClient";

afterEach(cleanup);

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

function fixture(items: TaggerReviewItem[], folders: Record<string, string[]> = {}) {
  const api: TaggerDecisionApi = {
    decide: vi.fn(async () => 1),
    decideBatch: vi.fn(async () => 1),
    move: vi.fn(async () => 1),
    classifications: vi.fn(async (id) => folders[id] ?? ["child"]),
  };
  const onItemsChange = vi.fn(), onBack = vi.fn();
  render(<WorkspaceChromeProvider scope="tagger-test"><ChromeTarget name="navigation" />
    <TaggerReview items={items} targets={targets} classifications={classifications} privacyMode={false} api={api} onItemsChange={onItemsChange} onBack={onBack} />
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
