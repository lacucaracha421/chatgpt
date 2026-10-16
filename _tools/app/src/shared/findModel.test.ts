import { describe, expect, it, vi } from "vitest";
import { FIND_SCOPES, allowsSceneSearch, findGroups, nameMatchRank, type FindContext } from "./findModel";
import type { NavigationEntry } from "./findEntries";

const row = (id: string, group: NavigationEntry["group"], label = "레베카", extra: Partial<NavigationEntry> = {}): NavigationEntry => ({ id, group, label, icon: null, run: vi.fn(), ...extra });
const ordered = (rows: NavigationEntry[], context: FindContext, query = "레베카", recent: string[] = []) => findGroups(rows, query, "전체", recent, context).flatMap(group => group.items);

describe("accepted find priority", () => {
  it("uses the same fixed chips on every tab and separates tags from menus", () => {
    expect(FIND_SCOPES).toEqual(["전체", "작품", "폴더·캐릭터", "태그", "작가", "메모", "메뉴"]);
    const rows = [row("tag", "tag"), row("go", "go"), row("action", "action"), row("settings", "settings")];
    expect(findGroups(rows, "레베카", "태그", []).flatMap(group => group.items).map(entry => entry.id)).toEqual(["tag"]);
    expect(findGroups(rows, "레베카", "메뉴", []).flatMap(group => group.items)).toHaveLength(3);
    expect(findGroups(rows, "레베카", "메뉴", []).map(group => group.group)).toEqual(["best", "menu"]);
  });
  it("keeps every strong result ahead of weak results even in the preferred group", () => {
    const rows = [row("place", "place", "옛레베카"), row("tag", "tag", "x", { keywords: ["레베카"] }), row("work", "work", "레베카 작품")];
    expect(ordered(rows, { tab: "assets" }).map(entry => entry.id)).toEqual(["tag", "work", "place"]);
    expect(nameMatchRank(row("initial", "place", "레베카"), "ㄹㅂㅋ")).toBe(3);
    expect(nameMatchRank(row("word", "work", "The Rebecca Story"), "rebecca")).toBe(2);
    expect(nameMatchRank(row("alias", "tag", "안경", { keywords: ["glasses"] }), "glass")).toBe(1);
  });
  it.each([
    ["assets", "place"], ["home", "work"], ["collections", "work"], ["manga", "work"], ["notes", "note"], ["menu", "go"],
  ] as const)("selects the %s tab's preferred strong name", (tab, expected) => {
    const rows = [row("go", "go"), row("note", "note"), row("tag", "tag"), row("artist", "artist"), row("work", "work", "レベカ", { keywords: ["레베카"], workType: "manga" }), row("place", "place")];
    const groups = findGroups(rows, "레베카", "전체", [], { tab });
    expect(groups[0].group).toBe("best");
    expect(groups[0].items[0].id).toBe(expected);
    expect(groups.flatMap(group => group.items).filter(entry => entry.id === expected)).toHaveLength(1);
  });
  it("puts the current collection type first and only manga works ahead of Manga menus", () => {
    const rows = [row("game", "work", "레베카", { workType: "game" }), row("manga", "work", "레베카 만화", { workType: "manga" }), row("menu", "go")];
    expect(ordered(rows, { tab: "collections", workType: "manga" })[0].id).toBe("manga");
    expect(ordered(rows.filter(entry => entry.id !== "manga"), { tab: "manga" })[0].id).toBe("menu");
  });
  it("ranks same asset names character, folder, album, then tag", () => {
    const rows = [row("tag", "tag"), row("place-album-a", "place"), row("place-folder-f", "place"), row("place-character-c", "place")];
    expect(ordered(rows, { tab: "assets" }, "레베카", ["place-album-a"]).map(entry => entry.id)).toEqual(["place-character-c", "place-folder-f", "place-album-a", "tag"]);
  });
  it("orders exact, prefix, word-start, recent, count and shorter names within a group", () => {
    const rows = [row("short", "artist", "레베카 A"), row("many", "artist", "레베카 길고 긴 이름", { count: 10 }), row("recent", "artist", "레베카 최근 이름"), row("exact", "artist"), row("word", "artist", "작가 레베카")];
    expect(ordered(rows, { tab: "assets" }, "레베카", ["recent"]).map(entry => entry.id)).toEqual(["exact", "recent", "many", "short", "word"]);
  });
  it("uses screen search or scene search as the fallback, and keeps a non-best scene row last", () => {
    const scene = row("scene", "content"), search = row("screen-search", "search");
    const weak = row("weak", "place", "옛레베카");
    expect(ordered([weak, scene], { tab: "assets" })[0]).toBe(scene);
    expect(ordered([weak, scene, search], { tab: "collections" })[0]).toBe(search);
    expect(ordered([weak, row("strong", "tag"), scene], { tab: "assets" }).map(entry => entry.id)).toEqual(["strong", "weak", "scene"]);
    for (const tab of ["collections", "manga", "notes", "menu"] as const) {
      expect(allowsSceneSearch(tab)).toBe(false);
      expect(ordered([scene], { tab })).toEqual([]);
    }
  });
});

// Exercise the retained feature while the shipped default remains paused.
vi.mock("../../nl-search-runtime/enabled.json", () => ({ default: true }));
