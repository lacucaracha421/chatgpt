import { describe, expect, it } from "vitest";
import "../styles/global.css";

describe("root scroll ownership", () => {
  it("locks the document viewport so only inner containers scroll", () => {
    const root = document.createElement("div");
    root.id = "root";
    document.body.append(root);

    expect(getComputedStyle(document.documentElement).overflow).toBe("hidden");
    expect(getComputedStyle(document.body).overflow).toBe("hidden");
    expect(getComputedStyle(root).overflow).toBe("hidden");

    root.remove();
  });
});
