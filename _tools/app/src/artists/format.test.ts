import { describe, expect, it } from "vitest";
import { artistHandle } from "./format";

describe("artistHandle", () => {
  it("prefers a handle, preserves numeric ids, and otherwise shows the URL host", () => {
    expect(artistHandle({ keys: ["https://x.com/ignored", "draws"] })).toBe("@draws");
    expect(artistHandle({ keys: ["12345"] })).toBe("12345");
    expect(artistHandle({ keys: ["https://www.pixiv.net/users/12345"] })).toBe("pixiv.net");
    expect(artistHandle({ keys: [] })).toBeNull();
  });
});
