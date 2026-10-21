import { describe, expect, it } from "vitest";
import type { CharacterTarget } from "../../characters/api";
import type { ClassificationEntry, FavoriteEntry } from "../../library/types";
import { birthdayDays, favoriteScopes, reorderCommand, representativeAsset } from "./model";

describe("favourite character presentation", () => {
  it("shows birthdays within 30 calendar days, including the year boundary and leap day", () => {
    const now = new Date(2026, 11, 20, 23, 30);
    expect(birthdayDays(1, 1, now)).toBe(12);
    expect(birthdayDays(1, 19, now)).toBe(30);
    expect(birthdayDays(1, 20, now)).toBeNull();
    expect(birthdayDays(12, 20, now)).toBe(0);
    expect(birthdayDays(2, 29, new Date(2027, 1, 28))).toBeNull();
    expect(birthdayDays(2, 29, new Date(2028, 1, 28))).toBe(1);
    expect(birthdayDays(null, null, now)).toBeNull();
  });

  it("uses the chosen cover, character thumbnail, then the first folder asset", () => {
    expect(representativeAsset({ coverAssetId: "cover" }, { thumbnailAssetId: "thumb" }, "first")).toBe("cover");
    expect(representativeAsset({ coverAssetId: null }, { thumbnailAssetId: "thumb" }, "first")).toBe("thumb");
    expect(representativeAsset(undefined, { thumbnailAssetId: null }, "first")).toBe("first");
    expect(representativeAsset(undefined, {})).toBeNull();
  });

  it("counts favourites in their top-level container and omits empty containers", () => {
    const classifications = [
      { id: "games", name: "게임", isContainer: true, parentId: null },
      { id: "manga", name: "만화", isContainer: true, parentId: null },
      { id: "empty", name: "빈 분류함", isContainer: true, parentId: null },
      { id: "series", name: "시리즈", parentId: "games" },
      { id: "other", name: "다른 시리즈", parentId: "manga" },
    ] as ClassificationEntry[];
    const targets = [{ seriesClassificationId: "series" }, { seriesClassificationId: "series" }, { seriesClassificationId: "other" }] as CharacterTarget[];
    expect(favoriteScopes(targets, classifications)).toEqual([
      { value: "all", label: "전체", count: 3 }, { value: "games", label: "게임", count: 2 }, { value: "manga", label: "만화", count: 1 },
    ]);
  });

  it("reorders the filtered slots while preserving hidden favourites in the full order command", () => {
    const entries = ["a", "hidden", "b", "deleted", "c"].map(characterId => ({ characterId })) as FavoriteEntry[];
    expect(reorderCommand(entries, ["a", "b", "c"], ["c", "a", "b"])).toEqual({ op: "order", ids: ["c", "hidden", "a", "deleted", "b"] });
    expect(reorderCommand(entries, ["a", "b", "c"], ["a", "b", "c"])).toBeNull();
  });
});
