import { describe, expect, it } from "vitest";
import { commandErrorMessage } from "./errorMessage";

describe("commandErrorMessage", () => {
  it("reads a Tauri CommandError object", () => {
    expect(
      commandErrorMessage(
        { code: "database_failed", message: "SQLite 작업이 실패했습니다" },
        "fallback",
      ),
    ).toBe("SQLite 작업이 실패했습니다");
  });

  it("reads a serialized Tauri CommandError", () => {
    expect(
      commandErrorMessage(
        '{"code":"database_failed","message":"직렬화된 오류입니다"}',
        "fallback",
      ),
    ).toBe("직렬화된 오류입니다");
  });

  it("reads Error and plain string messages", () => {
    expect(commandErrorMessage(new Error("오류 객체"), "fallback")).toBe(
      "오류 객체",
    );
    expect(commandErrorMessage("일반 오류", "fallback")).toBe("일반 오류");
  });

  it("uses the caller fallback for an unusable value", () => {
    expect(commandErrorMessage({ code: "missing_message" }, "fallback")).toBe(
      "fallback",
    );
    expect(commandErrorMessage("", "fallback")).toBe("fallback");
  });
});
