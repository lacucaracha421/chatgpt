import { expect, it } from "vitest";
import { findLinksNote, keepLink, linkUrl, newLinksNote, parseLinks, serializeLinks } from "./links";

it("round trips a readable fenced note with preview metadata", () => {
  const links = [{ url: "https://example.org/", title: "한글 제목", imageUrl: "https://example.org/a.png", siteName: "예시", savedAt: "2026-10-16T00:00:00Z", imported: 2 }];
  expect(parseLinks(serializeLinks(links))).toEqual(links);
  expect(newLinksNote(links)).toMatchObject({ title: "링크 보관", localRevision: 0, pending: true });
});
it("accepts raw JSON and plain URL lines but refuses damaged notes", () => {
  expect(parseLinks("https://a.org\nhttps://b.org").map(row => row.url)).toEqual(["https://a.org/", "https://b.org/"]);
  expect(parseLinks("[]")).toEqual([]);
  for (const value of ["메모를 덮어쓰면 안 됨", "```json\n{broken}\n```", '[{"url":"javascript:alert(1)"}]', "```json\n[]\n```\n추가 메모"]) expect(() => parseLinks(value)).toThrow();
});
it("moves a duplicate to the top, keeping its preview and import result", () => {
  const first = keepLink([], "https://a.org");
  first[0] = { ...first[0], title: "A", imported: 1, imageUrl: "https://a.org/i.png" };
  const second = keepLink(first, "https://b.org");
  const result = keepLink(second, "https://a.org/", new Date("2026-10-16T00:00:00Z"));
  expect(result).toHaveLength(2);
  expect(result[0]).toMatchObject({ title: "A", imported: 1, savedAt: "2026-10-16T00:00:00.000Z" });
});
it("accepts only web URLs without embedded credentials", () => {
  for (const value of ["file:///a.png", "javascript:alert(1)", "ftp://a.org", "https://user:pass@a.org"]) expect(linkUrl(value)).toBeNull();
  expect(linkUrl(" https://example.org ")).toBe("https://example.org/");
});
it("finds the dedicated note by saved id or oldest title and ignores trash", () => {
  const oldest = { ...newLinksNote([]), id: "old", createdAt: "2026-10-01" };
  const newer = { ...newLinksNote([]), id: "new", createdAt: "2026-10-02" };
  expect(findLinksNote([newer, oldest], null)?.id).toBe("old");
  expect(findLinksNote([newer, oldest], "new")?.id).toBe("new");
  expect(findLinksNote([{ ...oldest, deleted: true }, newer], "old")?.id).toBe("new");
});
