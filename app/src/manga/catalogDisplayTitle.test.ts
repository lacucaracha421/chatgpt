import { describe, expect, it } from "vitest";
import { catalogDisplayTitle } from "./catalogDisplayTitle";

describe("catalogDisplayTitle", () => {
  it("prefers the appended Korean title from the reported bilingual entry", () => {
    expect(catalogDisplayTitle("[Hotate Chanpon (Hotate-chan)] DeliHeal Yondara Wakareta Kanojo no Mama ga Kita | 데리헤루 불렀더니 헤어진 여친의 엄마가 왔다 [Korean] [Digital]"))
      .toBe("데리헤루 불렀더니 헤어진 여친의 엄마가 왔다");
  });
  it("removes event, creator and franchise metadata but keeps title punctuation", () => {
    expect(catalogDisplayTitle("(C108) [Nobutorakai (Nidaime)] Natsu no Majo! | 여름의 마녀는 조심하도록! (Genshin Impact) [Korean]"))
      .toBe("여름의 마녀는 조심하도록!");
  });
  it("retains numbers and Korean edition qualifiers", () => {
    expect(catalogDisplayTitle("[작가] 3명의 이야기 (후편) [Korean]")).toBe("3명의 이야기 (후편)");
    expect(catalogDisplayTitle("Original | SF 이야기 2 [Korean]")).toBe("SF 이야기 2");
  });
  it("removes leading labels even without a Korean title, preserving other brackets", () => {
    const original = "[Artist] English title [Japanese]";
    expect(catalogDisplayTitle(original)).toBe("English title [Japanese]");
    expect(catalogDisplayTitle("[한글 작가] English title [Korean]")).toBe("English title [Korean]");
    expect(catalogDisplayTitle("(C108) [Artist (Alias)] (Group) Title [Part 2] end")).toBe("Title [Part 2] end");
    expect(catalogDisplayTitle("(Group (Alias)) [Artist] Title (Part 2)")).toBe("Title (Part 2)");
    expect(catalogDisplayTitle("[Unclosed Title")).toBe("[Unclosed Title");
  });
});
