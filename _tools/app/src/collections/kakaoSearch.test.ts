import { expect, it, vi } from "vitest";
import { searchKakaoWithOriginal } from "./kakaoSearch";

it("tries the original title once after an empty initial search", async () => {
  const search = vi.fn().mockResolvedValue([]);
  expect(await searchKakaoWithOriginal("한국어", "日本語", search, () => true))
    .toEqual({query: "日本語", items: [], usedOriginalTitle: true});
  expect(search.mock.calls).toEqual([["한국어"], ["日本語"]]);
});

it("keeps user searches and successful initial results", async () => {
  const edited = vi.fn().mockResolvedValue([]);
  await searchKakaoWithOriginal("edited", "日本語", edited, () => false);
  expect(edited).toHaveBeenCalledTimes(1);
  const successful = vi.fn().mockResolvedValue(["series"]);
  expect((await searchKakaoWithOriginal("한국어", "日本語", successful, () => true)).items).toEqual(["series"]);
  expect(successful).toHaveBeenCalledTimes(1);
});
