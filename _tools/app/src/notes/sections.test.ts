import { describe, expect, it } from "vitest";
import { appendSection, deleteSection, moveSection, renameSection, replaceSectionBody, splitSections, unfixSection } from "./sections";

describe("note sections", () => {
  it("splits headings while preserving CRLF ranges and ignoring fenced or escaped hashes", () => {
    const body = "앞\r\n~~~\r\n# 물결 코드\r\n~~~\r\n```\r\n# 코드\r\n```\r\n# 하나 ###\r\n첫 줄\r\n\r\n## 둘\r\n내용\r\n\\# 일반 줄\r\n";
    const parsed = splitSections(body);
    expect(body.slice(parsed.preamble.start, parsed.preamble.end)).toBe("앞\r\n~~~\r\n# 물결 코드\r\n~~~\r\n```\r\n# 코드\r\n```\r\n");
    expect(parsed.sections.map(({ level, title, lineCount, key }) => ({ level, title, lineCount, key }))).toEqual([
      { level: 1, title: "하나", lineCount: 1, key: JSON.stringify(["하나", 0]) },
      { level: 2, title: "둘", lineCount: 2, key: JSON.stringify(["둘", 0]) },
    ]);
    expect(body.slice(parsed.sections[0]!.bodyRange.start, parsed.sections[0]!.bodyRange.end)).toBe("첫 줄\r\n\r\n");
  });

  it("keeps a heading with no body and notes without headings as one preamble", () => {
    expect(splitSections("## 제목\n").sections[0]).toMatchObject({ title: "제목", lineCount: 0 });
    expect(splitSections("일반\n본문")).toEqual({ preamble: { start: 0, end: 5 }, sections: [] });
  });

  it("replaces one body range without touching the other section bytes", () => {
    const body = "## 하나\nA\n## 둘\nB\n";
    const parsed = splitSections(body);
    const next = replaceSectionBody(body, parsed.sections[0]!, "바뀜");
    expect(next).toBe("## 하나\n바뀜\n## 둘\nB\n");
    expect(next.slice(next.indexOf("## 둘"))).toBe(body.slice(body.indexOf("## 둘")));
  });

  it("renames, moves, unfixes, deletes and appends sections", () => {
    const body = "## 하나\nA\n### 하위\nchild\n## 둘\nB\n## 셋\nC\n";
    const parsed = splitSections(body);
    const renamed = renameSection(body, parsed.sections[3]!, "새 셋");
    expect(renamed).toContain("## 새 셋\nC");
    expect(moveSection(body, parsed.sections[3]!, "up")).toBe("## 하나\nA\n### 하위\nchild\n## 셋\nC\n## 둘\nB\n");
    expect(moveSection(body, parsed.sections[0]!, "down")).toBe("### 하위\nchild\n## 둘\nB\n## 하나\nA\n## 셋\nC\n");
    expect(unfixSection(body, parsed.sections[1]!)).toBe("## 하나\nA\n하위\nchild\n## 둘\nB\n## 셋\nC\n");
    expect(deleteSection(body, parsed.sections[3]!)).toBe("## 하나\nA\n### 하위\nchild\n## 둘\nB\n");
    expect(appendSection("## 하나\nA\n")).toBe("## 하나\nA\n## 새 제목\n");
  });
});
