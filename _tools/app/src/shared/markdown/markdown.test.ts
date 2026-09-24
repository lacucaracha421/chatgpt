import { describe, expect, it } from "vitest";
import { parseInline, parseMarkdown, safeHttpUrl, toggleMarkdownTask, type MarkdownBlock, type MarkdownInline } from "./markdown";

const text = (value: string): MarkdownInline => ({ type: "text", text: value });

function plain(nodes: MarkdownInline[]): string {
  return nodes.map((node) => (node.type === "text" || node.type === "code" ? node.text : node.type === "break" ? "\n" : plain(node.children))).join("");
}

function linksIn(blocks: MarkdownBlock[]): string[] {
  const out: string[] = [];
  const walkInline = (nodes: MarkdownInline[]) => nodes.forEach((node) => {
    if (node.type === "link") out.push(node.href);
    if ("children" in node) walkInline(node.children);
  });
  const walk = (list: MarkdownBlock[]) => list.forEach((block) => {
    if (block.type === "heading" || block.type === "paragraph") walkInline(block.children);
    if (block.type === "blockquote") walk(block.children);
    if (block.type === "list") block.items.forEach((item) => { walkInline(item.children); walk(item.sublists); });
  });
  walk(blocks);
  return out;
}

describe("blocks", () => {
  it("parses ATX headings up to level 3 and leaves #### as text", () => {
    expect(parseMarkdown("# 하나\n## 둘 ##\n### 셋\n#### 넷\n#없음")).toEqual([
      { type: "heading", level: 1, children: [text("하나")] },
      { type: "heading", level: 2, children: [text("둘")] },
      { type: "heading", level: 3, children: [text("셋")] },
      { type: "paragraph", children: [text("#### 넷"), { type: "break" }, text("#없음")] },
    ]);
  });

  it("treats a single newline as a line break and a blank line as a paragraph break", () => {
    expect(parseMarkdown("첫 줄\n둘째 줄\n\n새 문단")).toEqual([
      { type: "paragraph", children: [text("첫 줄"), { type: "break" }, text("둘째 줄")] },
      { type: "paragraph", children: [text("새 문단")] },
    ]);
  });

  it("keeps fenced code verbatim, including an unclosed fence", () => {
    expect(parseMarkdown("```js\n**not bold** <b>\n  indented\n```\nafter")).toEqual([
      { type: "codeBlock", text: "**not bold** <b>\n  indented" },
      { type: "paragraph", children: [text("after")] },
    ]);
    expect(parseMarkdown("~~~\nopen\n# still code")).toEqual([{ type: "codeBlock", text: "open\n# still code" }]);
  });

  it("parses blockquotes with nested blocks", () => {
    expect(parseMarkdown("> 인용 **굵게**\n> - 항목")).toEqual([
      {
        type: "blockquote",
        children: [
          { type: "paragraph", children: [text("인용 "), { type: "strong", children: [text("굵게")] }] },
          { type: "list", ordered: false, start: 1, items: [{ line: 1, children: [text("항목")], sublists: [] }] },
        ],
      },
    ]);
  });

  it("parses horizontal rules", () => {
    expect(parseMarkdown("---\n* * *\n___")).toEqual([{ type: "hr" }, { type: "hr" }, { type: "hr" }]);
  });

  it("parses unordered and ordered lists with one level of nesting", () => {
    const blocks = parseMarkdown("- a\n* b\n  - b1\n    - deep\n  1. n1\n3. three\n4. four");
    expect(blocks).toEqual([
      {
        type: "list", ordered: false, start: 1, items: [
          { line: 0, children: [text("a")], sublists: [] },
          {
            line: 1, children: [text("b")], sublists: [
              { type: "list", ordered: false, start: 1, items: [{ line: 2, children: [text("b1")], sublists: [] }, { line: 3, children: [text("deep")], sublists: [] }] },
              { type: "list", ordered: true, start: 1, items: [{ line: 4, children: [text("n1")], sublists: [] }] },
            ],
          },
        ],
      },
      { type: "list", ordered: true, start: 3, items: [{ line: 5, children: [text("three")], sublists: [] }, { line: 6, children: [text("four")], sublists: [] }] },
    ]);
  });

  it("parses task items with their source line indexes", () => {
    const [, list] = parseMarkdown("제목\n\n- [ ] 우유\n- [x] 빵\n- [X] 잼\n- [] 아님\n  - [ ] 하위");
    expect(list).toMatchObject({
      type: "list",
      items: [
        { line: 2, checked: false, children: [text("우유")] },
        { line: 3, checked: true, children: [text("빵")] },
        { line: 4, checked: true, children: [text("잼")] },
        { line: 5, children: [text("[] 아님")], sublists: [{ items: [{ line: 6, checked: false, children: [text("하위")] }] }] },
      ],
    });
    expect((list as Extract<MarkdownBlock, { type: "list" }>).items[3]).not.toHaveProperty("checked");
  });

  it("counts CRLF lines and quoted task lines by their source index", () => {
    const blocks = parseMarkdown("a\r\n\r\n> - [ ] quoted\r\n");
    expect(blocks[1]).toMatchObject({ type: "blockquote", children: [{ type: "list", items: [{ line: 2, checked: false }] }] });
  });
});

describe("inlines", () => {
  it("parses bold, italic, nesting and code", () => {
    expect(parseInline("**굵게** *기울임* **a *b* c** `x*y*`")).toEqual([
      { type: "strong", children: [text("굵게")] },
      text(" "),
      { type: "em", children: [text("기울임")] },
      text(" "),
      { type: "strong", children: [text("a "), { type: "em", children: [text("b")] }, text(" c")] },
      text(" "),
      { type: "code", text: "x*y*" },
    ]);
  });

  it("leaves unclosed and space-flanked markers literal", () => {
    expect(parseInline("**open *half `tick a * b")).toEqual([text("**open *half `tick a * b")]);
    expect(parseInline("``a ` b``")).toEqual([{ type: "code", text: "a ` b" }]);
  });

  it("supports backslash escapes", () => {
    expect(parseInline("\\*not\\* \\[x\\](y) \\`c\\` a\\b")).toEqual([text("*not* [x](y) `c` a\\b")]);
  });

  it("parses http(s) links and bare autolinks", () => {
    expect(parseInline("[**문서**](https://example.com/a?b=1) 그리고 https://example.org/x_(y).")).toEqual([
      { type: "link", href: "https://example.com/a?b=1", children: [{ type: "strong", children: [text("문서")] }] },
      text(" 그리고 "),
      { type: "link", href: "https://example.org/x_(y)", children: [text("https://example.org/x_(y)")] },
      text("."),
    ]);
    expect(parseInline("<http://a.test/p>")).toEqual([text("<"), { type: "link", href: "http://a.test/p", children: [text("http://a.test/p")] }, text(">")]);
  });

  it("does not autolink inside code or words, nor nest links", () => {
    expect(parseInline("`https://a.test` xhttps://b.test")).toEqual([{ type: "code", text: "https://a.test" }, text(" xhttps://b.test")]);
    expect(parseInline("[see https://a.test](https://b.test)")).toEqual([{ type: "link", href: "https://b.test/", children: [text("see https://a.test")] }]);
  });

  it("renders images and non-http links as literal text", () => {
    expect(parseInline("![alt](https://a.test/i.png)")).toEqual([text("![alt](https://a.test/i.png)")]);
    expect(parseInline("[x](mailto:a@b.c) [y](/relative)")).toEqual([text("[x](mailto:a@b.c) [y](/relative)")]);
  });

  it("keeps raw HTML as literal text", () => {
    expect(parseInline('<img src=x onerror="alert(1)"><script>alert(1)</script>')).toEqual([
      text('<img src=x onerror="alert(1)"><script>alert(1)</script>'),
    ]);
  });
});

describe("unsafe URLs", () => {
  const attacks = [
    "javascript:alert(1)",
    "JaVaScRiPt:alert(1)",
    " javascript:alert(1)",
    "java\tscript:alert(1)",
    "java%0ascript:alert(1)",
    "&#106;avascript:alert(1)",
    "&#x6A;avascript:alert(1)",
    "javascript&colon;alert(1)",
    "data:text/html;base64,PHNjcmlwdD4=",
    "DATA:text/html,<script>",
    "vbscript:msgbox(1)",
    "VBScript:msgbox(1)",
    "file:///etc/passwd",
    "//evil.test",
    "https:/evil.test",
    "http://",
    "&#104;ttps://a.test",
  ];

  it.each(attacks)("rejects %j", (url) => {
    expect(safeHttpUrl(url)).toBeNull();
    const blocks = parseMarkdown(`[click](${url}) ${url}`);
    expect(linksIn(blocks)).toEqual([]);
  });

  it("rejects URLs with embedded whitespace", () => {
    expect(safeHttpUrl("https://exa mple.com")).toBeNull();
    expect(safeHttpUrl("https://a.test/\u0000")).toBeNull();
  });

  it("accepts http and https in any case", () => {
    expect(safeHttpUrl("HTTPS://Example.com/Path")).toBe("https://example.com/Path");
    expect(safeHttpUrl("http://a.test")).toBe("http://a.test/");
  });
});

describe("toggleMarkdownTask", () => {
  it("rewrites only the marker on the given line and keeps line endings", () => {
    const source = "- [ ] a\r\n  - [x] b\n> 1. [ ] c\nplain [ ]";
    expect(toggleMarkdownTask(source, 0, true)).toBe("- [x] a\r\n  - [x] b\n> 1. [ ] c\nplain [ ]");
    expect(toggleMarkdownTask(source, 1, false)).toBe("- [ ] a\r\n  - [ ] b\n> 1. [ ] c\nplain [ ]");
    expect(toggleMarkdownTask(source, 2, true)).toBe("- [ ] a\r\n  - [x] b\n> 1. [x] c\nplain [ ]");
    expect(toggleMarkdownTask(source, 3, true)).toBe(source);
    expect(toggleMarkdownTask(source, 9, true)).toBe(source);
  });

  it("round-trips with the line indexes reported by the parser", () => {
    const source = "intro\n\n- [ ] one\n  - [ ] two\n> - [ ] three";
    const lines: number[] = [];
    const collect = (blocks: MarkdownBlock[]) => blocks.forEach((block) => {
      if (block.type === "blockquote") collect(block.children);
      if (block.type === "list") block.items.forEach((item) => { if (item.checked !== undefined) lines.push(item.line); collect(item.sublists); });
    });
    collect(parseMarkdown(source));
    expect(lines).toEqual([2, 3, 4]);
    const toggled = lines.reduce((current, line) => toggleMarkdownTask(current, line, true), source);
    expect(toggled).toBe("intro\n\n- [x] one\n  - [x] two\n> - [x] three");
  });
});

describe("adversarial input", () => {
  it("stays bounded on deep quote and list markers", () => {
    const blocks = parseMarkdown(">".repeat(10_000) + " x\n" + "- ".repeat(5_000) + "y");
    let depth = 0;
    let node: MarkdownBlock | undefined = blocks[0];
    while (node?.type === "blockquote") { depth++; node = node.children[0]; }
    expect(depth).toBeLessThanOrEqual(4);
    expect(plain((node as Extract<MarkdownBlock, { type: "paragraph" }>).children)).toContain(">>>");
  });

  it("parses 300 KB of hostile input within a generous time bound", () => {
    const pieces = [
      "*".repeat(1000), "**a *b ", "`".repeat(7), "``` ", "[".repeat(2000), "](", "(".repeat(500), "![x](",
      "https://a.test/" + "a".repeat(3000) + " ", "\\", "> > > ", "- [ ] ", "1. ", "# ", "_ _ _", "<b onclick=x>",
      " ".repeat(2000) + "x", "(https://a\\", "(https://[", "(https://a.test" + ")".repeat(300), "*a".repeat(2000), "`a".repeat(2000), "[a](".repeat(1000), "http://".repeat(500),
    ];
    let source = "";
    for (let i = 0; source.length < 300_000; i++) source += pieces[i % pieces.length] + (i % 3 === 0 ? "\n" : "");
    const longLine = "*a **b [c](d `e ".repeat(20_000);
    const started = performance.now();
    parseMarkdown(source);
    parseMarkdown(longLine);
    parseMarkdown(("> ".repeat(50) + "- ".repeat(50) + "x\n").repeat(1500));
    expect(performance.now() - started).toBeLessThan(3000);
  });

  it("is deterministic", () => {
    const source = "# t\n- [ ] **a** https://x.test\n> *q*";
    expect(parseMarkdown(source)).toEqual(parseMarkdown(source));
  });
});
