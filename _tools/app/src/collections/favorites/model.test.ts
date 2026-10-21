import { describe, expect, it } from "vitest";
import type { CharacterTarget } from "../../characters/api";
import type { ClassificationEntry, FavoriteEntry } from "../../library/types";
import { birthdayDays, createFavoriteCommand, favoriteScopes, favoriteTargets, linkFavoriteCommand, reorderCommand, representativeAsset } from "./model";
import { applyCommands } from "./useFavoriteCharacters";

describe("favourite character presentation", () => {
  it("creates a named card, counts it only in all, and uses only its own cover", () => {
    const command = createFavoriteCommand("  새로운 캐릭터  ");
    expect(command).toMatchObject({ op: "create", name: "새로운 캐릭터" });
    expect("id" in command && command.id).toMatch(/^manual-[A-Za-z0-9_-]{1,57}$/);
    const document = applyCommands({ version: 1, revision: 0, entries: [] }, [command, command]);
    expect(document.entries).toHaveLength(1);
    const targets = favoriteTargets(document.entries, []);
    expect(targets[0].displayName).toBe("새로운 캐릭터");
    expect(favoriteScopes(targets, [{ id: "games", isContainer: true, parentId: null }] as ClassificationEntry[])).toEqual([{ value: "all", label: "전체", count: 1 }]);
    expect(favoriteScopes([...targets, { id: "asset-character", seriesClassificationId: "series" } as CharacterTarget], [
      { id: "games", name: "게임", isContainer: true, parentId: null }, { id: "series", parentId: "games" },
    ] as ClassificationEntry[])).toEqual([{ value: "all", label: "전체", count: 2 }, { value: "games", label: "게임", count: 1 }]);
    expect(representativeAsset(document.entries[0], { ...targets[0], thumbnailAssetId: "unrelated" }, "first")).toBeNull();
    expect(representativeAsset({ coverAssetId: "imported" }, targets[0])).toBe("imported");
  });

  it("links in place without losing profile, cover or works, and ignores manual names on asset edits", () => {
    const entry: FavoriteEntry = { characterId: "manual-new", name: "名前", seriesName: "作品", coverAssetId: "cover", coverY: 24, profile: { memo: "keep" }, workIds: ["work"], extraWorks: ["other"] };
    const existing = { ...entry, characterId: "existing", name: undefined, seriesName: undefined };
    const document = { version: 1 as const, revision: 2, entries: [existing, entry] };
    const command = linkFavoriteCommand(entry.characterId, "asset-character");
    expect(command).toEqual({ op: "link", id: "manual-new", characterId: "asset-character" });
    const linked = applyCommands(document, [command, command]);
    const { name: _name, seriesName: _series, ...kept } = entry;
    expect(linked.entries).toEqual([existing, { ...kept, characterId: "asset-character" }]);
    expect(applyCommands(document, [linkFavoriteCommand(entry.characterId, "existing")])).toEqual(document);
    expect(applyCommands(linked, [{ op: "update", id: "asset-character", set: { name: "ignored", seriesName: "ignored" } }])).toEqual(linked);
  });
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
