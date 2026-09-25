import { expect, it } from "vitest";
import { byOrder, checklistMarkdown, keyBetween, labelKey, noteColorValue, normalizeLabel, placeInGroup, sequentialKeys, stripMarkdown, textToItems } from "./model";

const valid = (key: string) => /^[0-9A-Za-z]{1,48}$/.test(key) && !key.endsWith("0");

it("order keys sort between their neighbours and stay short when appending or prepending", () => {
  expect(keyBetween(null, null)).toBe("V");
  let last = keyBetween(null, null);
  for (let i = 0; i < 500; i++) { const next = keyBetween(last, null); expect(next > last && valid(next)).toBe(true); last = next; }
  expect(last.length).toBeLessThan(24); // ~31 appends per extra character
  let first = "V";
  for (let i = 0; i < 200; i++) { const next = keyBetween(null, first); expect(next < first && valid(next)).toBe(true); first = next; }
  let [a, b] = ["V", "W"];
  for (let i = 0; i < 30; i++) { const mid = keyBetween(a, b); expect(a < mid && mid < b && valid(mid)).toBe(true); if (i % 2) a = mid; else b = mid; }
  expect(() => keyBetween("b", "b")).toThrow();
  const keys = sequentialKeys(500);
  expect([...keys].sort()).toEqual(keys);
  expect(new Set(keys).size).toBe(500);
});

it("placing an item rewrites only its key, and renumbers the group when keys collide", () => {
  const items = [{ id: "a", order: "V" }, { id: "b", order: "h" }, { id: "c", order: "m" }];
  const moved = placeInGroup(items, [...items].sort(byOrder), "c", 0);
  expect([...moved].sort(byOrder).map((i) => i.id)).toEqual(["c", "a", "b"]);
  expect(moved.filter((i, n) => i.order !== items[n]!.order).map((i) => i.id)).toEqual(["c"]);
  const tied = [{ id: "a", order: "m" }, { id: "b", order: "m" }, { id: "c", order: "m" }];
  const fixed = placeInGroup(tied, [...tied].sort(byOrder), "c", 1);
  expect([...fixed].sort(byOrder).map((i) => i.id)).toEqual(["a", "c", "b"]);
});

it("converts between text and checklists and builds the same fallback as the backend", () => {
  const items = textToItems("# 제목\n- [x] 우유\n* 빵\n\n1. 달걀\n그냥 줄");
  expect(items.map((i) => [i.text, i.checked])).toEqual([["# 제목", false], ["우유", true], ["빵", false], ["달걀", false], ["그냥 줄", false]]);
  expect(checklistMarkdown(items)).toBe("- [ ] # 제목\n- [ ] 빵\n- [ ] 달걀\n- [ ] 그냥 줄\n- [x] 우유");
  expect(checklistMarkdown([{ id: "a", text: "두\n줄", checked: false, order: "V" }])).toBe("- [ ] 두 줄");
});

it("previews, labels and colours", () => {
  expect(stripMarkdown("# 제목\n**굵게** [링크](https://a.b) `코드`\n- [ ] 할 일")).toBe("제목 굵게 링크 코드 할 일");
  expect(normalizeLabel("  업무   메모 ")).toBe("업무 메모");
  expect(labelKey("Work")).toBe(labelKey("work"));
  expect(noteColorValue("blue")).toMatch(/^#/);
  expect(noteColorValue("magenta")).toBeNull();
  expect(noteColorValue(null)).toBeNull();
});
