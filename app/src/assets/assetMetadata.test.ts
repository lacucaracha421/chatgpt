import { describe, expect, it } from "vitest";

import {
  batchLabel,
  creatorLabel,
  importSourceLabel,
  localDateTime,
} from "./assetMetadata";

describe("asset metadata formatting", () => {
  it("combines creator names and normalized handles", () => {
    expect(creatorLabel("Example Artist", "example")).toBe(
      "Example Artist (@example)",
    );
    expect(creatorLabel(null, "@example")).toBe("@example");
    expect(creatorLabel(null, null)).toBe("—");
  });

  it("labels known import origins and hides unknown values", () => {
    expect(importSourceLabel("direct")).toBe("직접 추가");
    expect(importSourceLabel("browser_extension")).toBe("브라우저 확장");
    expect(importSourceLabel("metadata_import")).toBe("메타데이터 가져오기");
    expect(importSourceLabel("legacy_lakomics")).toBe("구버전 Lakomics 이전");
    expect(importSourceLabel("future_value" as never)).toBe("—");
    expect(importSourceLabel(null)).toBe("—");
  });

  it("formats valid timestamps and rejects invalid ones", () => {
    const formatted = localDateTime("2026-08-01T10:20:30Z");
    expect(formatted).not.toBe("—");
    expect(localDateTime("bad date")).toBe("—");
    expect(localDateTime(null)).toBe("—");
  });

  it("keeps batch identifiers compact", () => {
    expect(batchLabel("12345678-1234-4234-8234-123456789abc")).toBe(
      "12345678",
    );
    expect(batchLabel("short-id")).toBe("short-id");
    expect(batchLabel(null)).toBe("—");
  });
});
