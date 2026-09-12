import { describe, expect, it } from "vitest";
import { QR_MAX_BYTES, QR_VIEWBOX_SIZE, createQrMatrix, qrSvgPath } from "./qrCode";

function darkRatio(matrix: readonly (readonly boolean[])[]) {
  const dark = matrix.flat().filter(Boolean).length;
  return dark / (matrix.length * matrix.length);
}

describe("qrCode", () => {
  it("encodes the production pairing-link shape as a version 7 matrix", () => {
    const text = "https://laku-tokyo.tail0aa1a3.ts.net:8443/extension-pair#AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
    const matrix = createQrMatrix(text);
    expect(matrix).toHaveLength(45);
    expect(matrix.every((row) => row.length === 45)).toBe(true);
    expect(QR_VIEWBOX_SIZE).toBe(53);
    expect(darkRatio(matrix)).toBeGreaterThan(0.35);
    expect(darkRatio(matrix)).toBeLessThan(0.65);
    expect(qrSvgPath(matrix)).toContain("M4 4h1v1h-1z");
  });

  it("keeps the three finder patterns and fixed dark module", () => {
    const matrix = createQrMatrix("https://example.test/extension-pair#" + "B".repeat(43));
    for (const [row, column] of [[3, 3], [3, 41], [41, 3]]) {
      expect(matrix[row][column]).toBe(true);
      expect(matrix[row - 2][column]).toBe(false);
      expect(matrix[row - 3][column]).toBe(true);
    }
    expect(matrix[37][8]).toBe(true);
  });

  it("enforces the fixed version 7-M byte capacity", () => {
    expect(QR_MAX_BYTES).toBe(122);
    expect(() => createQrMatrix("a".repeat(122))).not.toThrow();
    expect(() => createQrMatrix("a".repeat(123))).toThrow(/too long/);
  });

  it("is deterministic and changes data modules for a different payload", () => {
    const first = createQrMatrix("https://example.test/extension-pair#" + "C".repeat(43));
    const again = createQrMatrix("https://example.test/extension-pair#" + "C".repeat(43));
    const other = createQrMatrix("https://example.test/extension-pair#" + "D".repeat(43));
    expect(first).toEqual(again);
    expect(other).not.toEqual(first);
  });
});
