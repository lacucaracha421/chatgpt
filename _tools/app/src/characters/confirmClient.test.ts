import { expect, it, vi } from "vitest";
import type { AssetSummary } from "../library/types";
import type { CharacterTarget } from "./api";
import { confirmTotal, readConfirmItems, readShadowList } from "./confirmClient";
import { confirmSourceFor, shadowItem } from "./confirmTestKit";
import type { TaggerReviewItem } from "./taggerReviewClient";

const targets = [{ id: "hina", seriesClassificationId: "series", displayName: "히나", references: [] }, { id: "kisaki", seriesClassificationId: "other", displayName: "키사키", references: [] }] as unknown as CharacterTarget[];
const tag = (id: string, targetId: string, seriesId: string): TaggerReviewItem => ({ asset: { id, originalName: `${id}.png`, width: 1, height: 1 } as AssetSummary, seriesId, targetId, targetName: targetId, targetFingerprint: "fp",
  evidence: { source: "tagger", reason: "recommendation", pixaiScore: 0.9, canaryScore: 0.9 } });

it("pages every shadow list and stops when a page brings nothing new", async () => {
  const items = [shadowItem("a", "hina", "히나"), shadowItem("b", "hina", "히나"), shadowItem("c", "hina", "히나")];
  const pages = [{ items: items.slice(0, 2), nextOffset: 2 }, { items: [items[1]!, items[2]!], nextOffset: 4 }, { items: [items[2]!], nextOffset: 6 }];
  const page = vi.fn(async ({ offset }: { offset: number }) => ({ ...pages[offset / 2], policyVersion: null, summary: {} }) as never);
  const read = await readShadowList({ page }, "candidates", undefined);
  expect(read?.map(item => item.assetId)).toEqual(["a", "b", "c"]);
  expect(page).toHaveBeenCalledTimes(3);
  expect(page).toHaveBeenCalledWith({ offset: 0, limit: 200 });
});

it("reads the doubtful list with its mode and the series scope", async () => {
  const page = vi.fn(async () => ({ items: [], nextOffset: null, policyVersion: null, summary: {} }) as never);
  await readShadowList({ page }, "doubtful", "series");
  expect(page).toHaveBeenCalledWith({ offset: 0, limit: 200, mode: "doubtful", seriesId: "series" });
});

it("merges the three reads, scoped by series and character, and resolves null once the reader is no longer wanted", async () => {
  const sources = confirmSourceFor({
    tagger: async () => [tag("t1", "hina", "series"), tag("t2", "kisaki", "other")],
    candidates: [shadowItem("c1", "hina", "히나"), shadowItem("c2", "kisaki", "키사키")],
  });
  const all = await readConfirmItems(sources, {}, targets);
  expect(all?.items.map(item => item.assetId).sort()).toEqual(["c1", "c2", "t1", "t2"]);
  // The tag list is cut to the series here; the recognition lists are scoped by the native read itself.
  const series = await readConfirmItems(sources, { series: { id: "series", name: "백합" } }, targets);
  expect(series?.items.map(item => item.assetId).sort()).toEqual(["c1", "c2", "t1"]);
  expect(sources.shadow.page).toHaveBeenCalledWith(expect.objectContaining({ seriesId: "series" }));
  const one = await readConfirmItems(sources, { series: { id: "other", name: "다른" }, target: { id: "kisaki", name: "키사키" } }, targets);
  expect(one?.items.map(item => item.assetId).sort()).toEqual(["c2", "t2"]);
  expect(await readConfirmItems(sources, {}, targets, () => false)).toBeNull();
});

it("reports a list that failed and still returns the others", async () => {
  const sources = confirmSourceFor({ candidates: [shadowItem("c1", "hina", "히나")] });
  sources.tagger.mockRejectedValue(new Error("nope"));
  const read = await readConfirmItems(sources, {}, targets);
  expect(read?.failed).toEqual(["tag"]);
  expect(read?.items.map(item => item.assetId)).toEqual(["c1"]);
});

it("adds the three kinds of a count read", () => {
  expect(confirmTotal({ recognition: 3, tag: 4, recheck: 5 })).toBe(12);
});

it("folds the 인식 추천 of far characters out of a wide read, keeps what else brings them up, and shows them in their own list", async () => {
  const sources = confirmSourceFor({
    tagger: async () => [tag("t1", "kisaki", "other")],
    candidates: [shadowItem("c1", "hina", "히나"), shadowItem("f1", "kisaki", "키사키", { folded: true }), shadowItem("f2", "kisaki", "키사키", { folded: true }), shadowItem("t1", "kisaki", "키사키", { folded: true })],
    doubtful: [shadowItem("f2", "kisaki", "키사키", { verdict: "none" })],
  });
  const all = await readConfirmItems(sources, {}, targets);
  // f1 is folded; t1 stays as the tag list's own 태그 추천; f2 is a 다시 확인 whatever the fold says.
  expect(all?.items.map(item => [item.assetId, item.kind]).sort()).toEqual([["c1", "recognition"], ["f2", "recheck"], ["t1", "tag"]]);
  expect(all?.folded.map(item => item.assetId)).toEqual(["f1"]);
  // A series list folds as well; one character's own list shows everything it has.
  const series = await readConfirmItems(sources, { series: { id: "other", name: "다른" } }, targets);
  expect(series?.folded.map(item => item.assetId)).toEqual(["f1"]);
  const one = await readConfirmItems(sources, { series: { id: "other", name: "다른" }, target: { id: "kisaki", name: "키사키" } }, targets);
  expect(one?.items.map(item => item.assetId).sort()).toEqual(["f1", "f2", "t1"]);
  expect(one?.folded).toEqual([]);
});
