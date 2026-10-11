import { expect, it } from "vitest";
import type { AssetSummary } from "../library/types";
import type { CharacterTarget } from "./api";
import { confirmCounts, confirmGroups, confirmSplitText, mergeConfirmItems, tallyConfirm } from "./confirmModel";
import { shadowItem } from "./confirmTestKit";
import type { TaggerReviewItem } from "./taggerReviewClient";

const target = (id: string, name: string, series: string | null = "series", references: string[] = []) => ({ id, seriesClassificationId: series, displayName: name, thumbnailAssetId: null,
  references: references.map((assetId, slot) => ({ slot, assetId, assetHash: "h", status: "ready" })) }) as unknown as CharacterTarget;
const targets = [target("hina", "히나", "series", ["r1", "r2", "r3", "r4", "r5"]), target("kisaki", "키사키")];
const asset = (id: string) => ({ id, originalName: `${id}.png`, width: 10, height: 20 }) as AssetSummary;
const tag = (id: string, reason: "recommendation" | "veto", targetId = "hina", pixai = 0.9, canary = 0.9): TaggerReviewItem => ({ asset: asset(id), seriesId: "series", targetId, targetName: targetId === "hina" ? "히나" : "키사키", targetFingerprint: "fp", evidence: { source: "tagger", reason, pixaiScore: pixai, canaryScore: canary } });

it("merges the lists, one item per character and image, under the highest kind", () => {
  const items = mergeConfirmItems({
    tagger: [tag("a", "recommendation"), tag("b", "veto"), tag("c", "recommendation", "kisaki", 0.9, 0.5), tag("d", "veto")],
    candidates: [shadowItem("a", "hina", "히나"), shadowItem("e", "hina", "히나", { verdict: "recommended" })],
    doubtful: [shadowItem("d", "hina", "히나", { verdict: "none" }), shadowItem("f", "kisaki", "키사키", { verdict: "none" })],
    targets,
  });
  expect(items.map(item => [item.assetId, item.targetId, item.kind])).toEqual([
    ["a", "hina", "recognition"], // the tags and the recognition both bring it up: shown once, as 인식 추천
    ["e", "hina", "recognition"],
    ["c", "kisaki", "tag"],
    ["b", "hina", "recheck"], // the tags doubt a placement
    ["d", "hina", "recheck"], // doubted by both
    ["f", "kisaki", "recheck"], // 학습 인식 doubts it
  ]);
  expect(confirmCounts(items)).toEqual({ recognition: 2, tag: 1, recheck: 3, total: 6 });
  expect(items[0]!.tags).toEqual({ reason: "recommendation", sure: true });
  expect(items.find(item => item.assetId === "c")!.tags).toEqual({ reason: "recommendation", sure: false });
  // References come from the recognition list when it has them, else from the character.
  expect(items.find(item => item.assetId === "c")!.referenceAssetIds).toEqual([]);
  expect(items.find(item => item.assetId === "b")!.referenceAssetIds).toEqual(["r1", "r2", "r3", "r4"]);
  expect(items.every(item => item.seriesId === "series")).toBe(true);
});

it("keeps one image under two characters as two items", () => {
  const items = mergeConfirmItems({ tagger: [], candidates: [shadowItem("a", "hina", "히나"), shadowItem("a", "kisaki", "키사키")], doubtful: [], targets });
  expect(items).toHaveLength(2);
});

it("tallies per character and groups per series, busiest first, with 기타 for a character without a series", () => {
  const ghost = target("ghost", "유령", null);
  const items = mergeConfirmItems({
    tagger: [tag("t1", "recommendation", "hina"), tag("t2", "recommendation", "hina")],
    candidates: [shadowItem("c1", "kisaki", "키사키"), shadowItem("c2", "ghost", "유령")],
    doubtful: [],
    targets: [...targets, ghost],
  });
  const groups = confirmGroups(tallyConfirm(items), [...targets, ghost], id => id === "series" ? "백합" : undefined);
  expect(groups.map(group => [group.seriesName, group.counts.total])).toEqual([["백합", 3], ["기타", 1]]);
  expect(groups[0]!.characters.map(character => [character.name, character.counts.total])).toEqual([["히나", 2], ["키사키", 1]]);
  expect(groups[0]!.counts).toEqual({ recognition: 1, tag: 2, recheck: 0, total: 3 });
  expect(confirmSplitText(groups[0]!.counts)).toBe("인식 추천 1 · 태그 추천 2");
});

it("lists folded characters under their series without adding to its counts", () => {
  const items = mergeConfirmItems({ tagger: [], candidates: [shadowItem("c1", "hina", "히나")], doubtful: [], targets });
  const folded = mergeConfirmItems({ tagger: [], candidates: [shadowItem("f1", "kisaki", "키사키", { folded: true }), shadowItem("f2", "kisaki", "키사키", { folded: true })], doubtful: [], targets });
  const groups = confirmGroups(tallyConfirm(items), targets, id => id === "series" ? "백합" : undefined, tallyConfirm(folded));
  expect(groups).toHaveLength(1);
  expect(groups[0]!.counts.total).toBe(1);
  expect(groups[0]!.characters.map(character => character.name)).toEqual(["히나"]);
  expect(groups[0]!.folded.map(character => [character.name, character.counts.total])).toEqual([["키사키", 2]]);
  // A series that only has folded characters still gets its group, with nothing counted.
  const onlyFolded = confirmGroups([], targets, id => id === "series" ? "백합" : undefined, tallyConfirm(folded));
  expect(onlyFolded.map(group => [group.seriesName, group.counts.total, group.folded.length])).toEqual([["백합", 0, 1]]);
});
