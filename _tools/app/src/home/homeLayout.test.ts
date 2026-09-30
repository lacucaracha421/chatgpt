import { readFileSync } from "node:fs";
import { expect, it } from "vitest";

it("reserves the filled shelf's full height for first load and empty content", () => {
  const style = document.createElement("style");
  style.textContent = readFileSync("src/home/home.css", "utf8");
  document.head.append(style);
  try {
    const rules = Array.from(style.sheet!.cssRules) as CSSStyleRule[];
    const declarations = (selector: string) => rules.find(rule => rule.selectorText === selector)!.style;
    const height = declarations(".home-shelf-frame").getPropertyValue("--home-shelf-height");
    // 20 date + 208 cover + 20 title + 20 platforms + three 4px gaps.
    expect(height).toBe("280px");
    for (const selector of [".home-shelf-frame", ".home-shelf__item", ".home-shelf--empty"]) {
      expect(declarations(selector).getPropertyValue("min-height")).toBe("var(--home-shelf-height)");
    }
  } finally { style.remove(); }
});
