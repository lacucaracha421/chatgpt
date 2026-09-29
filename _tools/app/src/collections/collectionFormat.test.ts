import { describe, expect, it } from "vitest";
import { collectionCredit, volumeLabel } from "./collectionFormat";

describe("collectionFormat", () => {
  it("adds 권 only to numeric volume labels", () => {
    expect(volumeLabel({ volumeNumber: 1, displayLabel: "1" })).toBe("1권");
    expect(volumeLabel({ volumeNumber: 1, displayLabel: "상권" })).toBe("상권");
    expect(volumeLabel({ volumeNumber: 2, displayLabel: "" })).toBe("2권");
  });

  it("uses the AV maker before the production-company fallback", () => {
    expect(collectionCredit({ type: "av", av: { maker: "Maker" }, productionCompany: "Studio" })).toBe("Maker");
    expect(collectionCredit({ type: "av", av: null, productionCompany: "Studio" })).toBe("Studio");
  });
});
