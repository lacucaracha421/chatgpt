import { describe, expect, it } from "vitest";
import { autoTagLabel, buildAutoTagView, characterName, characterSeries, searchAutoTags } from "./autoTagModel";
import type { AssetAutoTag, AutoTagVocabularyEntry } from "./types";

const model = (tag: string, score: number, category: AssetAutoTag["category"] = "general"): AssetAutoTag => ({ tag, category, score, source: "model" });

describe("buildAutoTagView", () => {
  it("groups by kind in the fixed order and puts common tags last in their group", () => {
    const view = buildAutoTagView({ hasConfirmedCharacter: false, tags: [
      model("1girl", 0.99), model("long_hair", 0.96), model("pink_hair", 0.94), model("nipples", 0.92), model("white_background", 0.9),
      model("bed", 0.75), model("thighband_pantyhose", 0.4), model("twitter_username", 0.8), model("solo", 0.97), model("halo", 0.6),
    ] });
    expect(view.groups.map((group) => group.key)).toEqual(["body", "sex", "scene", "etc"]);
    const body = view.groups[0].chips;
    expect(body.map((chip) => chip.tag)).toEqual(["pink_hair", "halo", "1girl", "solo", "long_hair"]);
    expect(body.filter((chip) => chip.common).map((chip) => chip.tag)).toEqual(["1girl", "solo", "long_hair"]);
    expect(view.groups[2].chips.map((chip) => chip.tag)).toEqual(["bed", "white_background"]);
    // Outside the dictionary: English with spaces, in 기타. Watermark-like tags are hidden.
    expect(view.groups[3].chips[0].label).toBe("thighband pantyhose");
    expect(view.total).toBe(9);
    expect(body[0].label).toBe("분홍 머리");
  });

  it("shows a guessed character only at 0.85 or more and without a confirmed character", () => {
    const tags = [model("vertin_(reverse:1999)", 0.91, "character"), model("sonetto_(reverse:1999)", 0.6, "character"), model("smile", 0.8)];
    const view = buildAutoTagView({ hasConfirmedCharacter: false, tags });
    expect(view.characters.map((chip) => chip.tag)).toEqual(["vertin_(reverse:1999)"]);
    expect(view.characters[0]).toMatchObject({ guessed: true, label: "Vertin", group: "character" });
    expect(view.groups[0].key).toBe("character");
    const confirmed = buildAutoTagView({ hasConfirmedCharacter: true, tags });
    expect(confirmed.characters).toEqual([]);
    expect(confirmed.groups.map((group) => group.key)).toEqual(["pose"]);
    // A character the user added stays, but is not a guess.
    const added = buildAutoTagView({ hasConfirmedCharacter: true, tags: [{ tag: "ellen_joe", category: "character", score: null, source: "added" }] });
    expect(added.groups[0].chips[0]).toMatchObject({ guessed: false, source: "added" });
  });

  it("orders user-added tags before scored ones", () => {
    const view = buildAutoTagView({ hasConfirmedCharacter: false, tags: [model("skirt", 0.9), { tag: "glasses", category: "general", score: null, source: "added" }] });
    expect(view.groups[0].chips.map((chip) => chip.tag)).toEqual(["glasses", "skirt"]);
  });
});

describe("character names", () => {
  it("derives the series from the qualifier or the explicit map", () => {
    expect(characterName("vertin_(reverse:1999)")).toBe("Vertin");
    expect(characterSeries("vertin_(reverse:1999)")).toBe("리버스:1999");
    expect(characterSeries("asuna_(blue_archive)")).toBe("블루 아카이브");
    expect(characterSeries("ellen_joe")).toBe("젠레스 존 제로");
    expect(characterName("ellen_joe")).toBe("Ellen Joe");
    expect(characterSeries("elysia_(herrscher_of_human:_ego)_(honkai_impact)")).toBe("붕괴3rd");
    expect(characterName("elysia_(herrscher_of_human:_ego)_(honkai_impact)")).toBe("Elysia");
    expect(characterSeries("kiana_kaslana_(herrscher_of_finality)")).toBe("붕괴3rd");
    expect(characterSeries("chief_(path_to_nowhere)")).toBe("Path To Nowhere");
    expect(characterSeries("unknown_person")).toBeNull();
    expect(autoTagLabel("37_(reverse:1999)", "character")).toBe("37");
  });
});

describe("searchAutoTags", () => {
  const entries: AutoTagVocabularyEntry[] = [
    { tag: "thighhighs", category: "general", count: 1410 },
    { tag: "black_thighhighs", category: "general", count: 720 },
    { tag: "white_thighhighs", category: "general", count: 310 },
    { tag: "heterochromia", category: "general", count: 260 },
    { tag: "vertin_(reverse:1999)", category: "character", count: 463 },
    { tag: "watermark", category: "general", count: 900 },
    { tag: "rare_tag", category: "general", count: 0 },
  ];
  it("matches Korean and English, exact and prefix first", () => {
    expect(searchAutoTags(entries, "사이하").map((entry) => entry.tag)).toEqual(["thighhighs", "black_thighhighs", "white_thighhighs"]);
    expect(searchAutoTags(entries, "오드").map((entry) => entry.label)).toEqual(["오드아이"]);
    expect(searchAutoTags(entries, "hetero").map((entry) => entry.tag)).toEqual(["heterochromia"]);
    expect(searchAutoTags(entries, "black thigh").map((entry) => entry.tag)).toEqual(["black_thighhighs"]);
    expect(searchAutoTags(entries, "vertin")[0]).toMatchObject({ label: "Vertin" });
  });
  it("skips hidden tags and, when asked, tags without assets", () => {
    expect(searchAutoTags(entries, "water")).toEqual([]);
    expect(searchAutoTags(entries, "rare").length).toBe(1);
    expect(searchAutoTags(entries, "rare", { minCount: 1 })).toEqual([]);
  });
});
