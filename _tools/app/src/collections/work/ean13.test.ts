import { describe, expect, it } from "vitest";
import { encodeEan13 } from "./ean13";

describe("EAN-13", () => {
  it("encodes ISBN 9780306406157 as 95 modules with its 9-prefix parity", () => {
    const bits = encodeEan13("9780306406157");
    expect(bits).toBe("101" + "0111011" + "0001001" + "0100111" + "0111101" + "0100111" + "0101111" + "01010" + "1011100" + "1110010" + "1010000" + "1100110" + "1001110" + "1000100" + "101");
    expect(bits).toHaveLength(95);
  });
  it.each(["9780306406158", "978030640615", "97803064061570", "978-0306406157", "978030640615x", "", " 9780306406157"])("rejects %j", value => {
    expect(encodeEan13(value)).toBeNull();
  });
});
