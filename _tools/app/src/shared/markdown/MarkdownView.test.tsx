import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MarkdownHelpButton, MARKDOWN_HELP_ROWS } from "./MarkdownHelp";
import { MarkdownView } from "./MarkdownView";

afterEach(cleanup);

function expectNoUnsafeMarkup(container: HTMLElement) {
  expect(container.querySelector("script, img, iframe, object, embed, style, svg, form, video, audio")).toBeNull();
  for (const element of Array.from(container.querySelectorAll("*"))) {
    for (const attribute of Array.from(element.attributes)) {
      expect(attribute.name.toLowerCase().startsWith("on"), `${element.tagName} ${attribute.name}`).toBe(false);
      expect(["src", "srcset", "style", "formaction", "xlink:href"]).not.toContain(attribute.name.toLowerCase());
    }
  }
  for (const anchor of Array.from(container.querySelectorAll("a"))) {
    expect(anchor.getAttribute("href")).toMatch(/^https?:\/\//);
    expect(anchor.getAttribute("rel")).toBe("noreferrer noopener");
  }
}

describe("MarkdownView", () => {
  it("renders every supported construct as elements", () => {
    const { container } = render(
      <MarkdownView
        source={[
          "# H1", "## H2", "### H3", "", "첫 줄", "**굵게** *기울임* `코드`", "", "> 인용", "", "---",
          "- a", "  - a1", "1. one", "", "```", "<b>코드</b>", "```", "[링크](https://example.com) https://a.test",
        ].join("\n")}
      />,
    );
    expect(container.querySelector("h1")?.textContent).toBe("H1");
    expect(container.querySelector("h2")?.textContent).toBe("H2");
    expect(container.querySelector("h3")?.textContent).toBe("H3");
    expect(container.querySelector("p br")).not.toBeNull();
    expect(container.querySelector("strong")?.textContent).toBe("굵게");
    expect(container.querySelector("em")?.textContent).toBe("기울임");
    expect(container.querySelector("p > code")?.textContent).toBe("코드");
    expect(container.querySelector("blockquote p")?.textContent).toBe("인용");
    expect(container.querySelector("hr")).not.toBeNull();
    expect(container.querySelector("ul > li > ul > li")?.textContent).toBe("a1");
    expect(container.querySelector("ol > li")?.textContent).toBe("one");
    expect(container.querySelector("pre > code")?.textContent).toBe("<b>코드</b>");
    expect(container.querySelector("pre b")).toBeNull();
    expect(Array.from(container.querySelectorAll("a"), (a) => a.getAttribute("href"))).toEqual(["https://example.com/", "https://a.test/"]);
    expectNoUnsafeMarkup(container);
  });

  it("shows raw HTML and unsafe links as literal text", () => {
    const hostile = [
      '<img src=x onerror="alert(1)">',
      "<script>alert(1)</script>",
      '<a href="javascript:alert(1)" onclick="x()">x</a>',
      "[a](javascript:alert(1)) [b](JAVASCRIPT:alert(1)) [c](&#106;avascript:alert(1)) [d](data:text/html,x) [e](vbscript:x)",
      "![i](https://a.test/i.png) <iframe src=https://a.test></iframe> <svg onload=x>",
      "javascript:alert(1) data:text/html,x",
    ].join("\n\n");
    const { container } = render(<MarkdownView source={hostile} />);
    expectNoUnsafeMarkup(container);
    // Only the bare https URL inside the literal iframe text becomes a (safe) link.
    expect(Array.from(container.querySelectorAll("a"), (a) => a.getAttribute("href"))).toEqual(["https://a.test/"]);
    expect(container.textContent).toContain('<img src=x onerror="alert(1)">');
    expect(container.textContent).toContain("<script>alert(1)</script>");
    expect(container.textContent).toContain("[a](javascript:alert(1))");
    expect(container.textContent).toContain("![i](https://a.test/i.png)");
  });

  it("opens links through the caller and never navigates", () => {
    const onOpenLink = vi.fn();
    render(<MarkdownView source="[문서](https://example.com/a)" onOpenLink={onOpenLink} />);
    const link = screen.getByRole("link", { name: "문서" });
    expect(link).toHaveAttribute("target", "_blank");
    const event = new MouseEvent("click", { bubbles: true, cancelable: true });
    link.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
    expect(onOpenLink).toHaveBeenCalledWith("https://example.com/a");
  });

  it("reports task toggles with the source line index", () => {
    const onToggleTask = vi.fn();
    render(<MarkdownView source={"제목\n\n- [ ] 우유\n- [x] 빵\n> - [ ] 인용 속"} onToggleTask={onToggleTask} />);
    fireEvent.click(screen.getByRole("checkbox", { name: "우유" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "빵" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "인용 속" }));
    expect(onToggleTask.mock.calls).toEqual([[2, true], [3, false], [4, true]]);
  });

  it("keeps checkboxes read-only without a toggle handler", () => {
    render(<MarkdownView source="- [x] 끝" />);
    expect(screen.getByRole("checkbox", { name: "끝" })).toBeDisabled();
    expect(screen.getByRole("checkbox", { name: "끝" })).toBeChecked();
  });
});

describe("MarkdownHelpButton (PC)", () => {
  it("opens a Korean cheat sheet showing each syntax next to its rendering", () => {
    render(<MarkdownHelpButton />);
    fireEvent.click(screen.getByRole("button", { name: "마크다운 도움말" }));
    const dialog = screen.getByRole("dialog", { name: "마크다운 도움말" });
    expect(Array.from(dialog.querySelectorAll("dt"), (dt) => dt.firstChild?.textContent)).toEqual(["제목", "굵게", "기울임", "목록", "할 일", "링크", "인용", "코드", "줄바꿈"]);
    expect(dialog.querySelectorAll(".markdown-help__row")).toHaveLength(MARKDOWN_HELP_ROWS.length);
    expect(within(dialog).getByText("**굵게**").tagName).toBe("CODE");
    expect(dialog.querySelector(".markdown-help__result strong")?.textContent).toBe("굵게");
    expect(dialog.querySelector(".markdown-help__result em")?.textContent).toBe("기울임");
    expect(dialog.querySelector(".markdown-help__result h1")?.textContent).toBe("제목");
    expect(dialog.querySelector(".markdown-help__result blockquote")?.textContent).toBe("인용");
    expect(within(dialog).getAllByRole("checkbox").every((box) => (box as HTMLInputElement).disabled)).toBe(true);
    expect(within(dialog).getByRole("link", { name: "텍스트" })).toHaveAttribute("href", "https://example.com/");
    fireEvent.click(within(dialog).getByRole("button", { name: "닫기" }));
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});
