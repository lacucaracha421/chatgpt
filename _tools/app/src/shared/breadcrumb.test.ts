import { describe, expect, it } from "vitest";
import { breadcrumbPath } from "./breadcrumb";

describe("breadcrumbPath", () => {
  it("uses the shared separator and stops safely at a cycle", () => {
    const nodes = [
      { id: "x", name: "X", parentId: "y" },
      { id: "y", name: "Y", parentId: "x" },
    ];
    expect(breadcrumbPath(nodes[0]!, nodes)).toBe("Y › X");
  });
});
