import { readFileSync } from "node:fs";
import { expect, it } from "vitest";

it("disables transitions and shortens animations for elements and their decoration", () => {
  const style = document.createElement("style");
  style.textContent = readFileSync("src/styles/shared-states.css", "utf8");
  document.head.append(style);
  try {
    const reduced = Array.from(style.sheet!.cssRules).find(rule =>
      (rule as CSSMediaRule).conditionText === "(prefers-reduced-motion: reduce)") as CSSMediaRule;
    const reset = reduced.cssRules[0] as CSSStyleRule;
    expect(reset.selectorText.split(",").map(selector => selector.trim())).toEqual(["*", "*::before", "*::after"]);
    expect(reset.style.getPropertyValue("transition")).toBe("none");
    expect(reset.style.getPropertyPriority("transition")).toBe("important");
    // Animations keep delay and fill mode so delayed or timed states still resolve.
    expect(reset.style.getPropertyValue("animation-duration")).toBe("0.01ms");
    expect(reset.style.getPropertyValue("animation")).toBe("");
    expect(reset.style.getPropertyValue("scroll-behavior")).toBe("auto");
    expect(Array.from(reduced.cssRules).slice(1).map(rule => (rule as CSSStyleRule).selectorText))
      .toEqual([".manga-cover-viewer__collectible", ".manga-cover-viewer__glare"]);
  } finally { style.remove(); }
});
