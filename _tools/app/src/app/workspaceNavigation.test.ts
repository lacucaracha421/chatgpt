import { describe, expect, it } from "vitest";
import { backNavigationTab } from "./workspaceNavigation";

describe("backNavigationTab", () => {
  it("keeps the 내용 검색 result state in the 에셋 history, so back and 검색 해제 return to the view it came from", () => {
    expect(backNavigationTab({ kind: "description_search", query: "눈 내리는 겨울" })).toBe("assets");
    expect(backNavigationTab({ kind: "description_search", query: "눈" })).toBe(backNavigationTab({ kind: "classification", classificationId: "folder" }));
    expect(backNavigationTab({ kind: "description_search", query: "눈" })).not.toBe(backNavigationTab({ kind: "home" }));
  });
});
