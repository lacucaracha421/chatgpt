import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ExtensionPairingQr } from "./ExtensionPairingQr";

const value = {
  pairingUrl: "https://laku-tokyo.tail0aa1a3.ts.net:8443/extension-pair#AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
  expiresAt: "2026-09-09T07:30:00.000Z",
};

describe("ExtensionPairingQr", () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date("2026-09-09T07:20:00.000Z")); });
  afterEach(() => { cleanup(); vi.useRealTimers(); });

  it("shows a scan-first QR surface with a compact expiry timer", () => {
    render(<ExtensionPairingQr value={value} onCopy={() => undefined} onRefresh={() => undefined} onClose={() => undefined} />);
    expect(screen.getByRole("img", { name: "Lakomics 확장 연결 QR 코드" })).toBeInTheDocument();
    expect(screen.getByText("10:00")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "링크 복사" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "새로 발급" })).toBeEnabled();
  });

  it("offers PC copy instructions without constructing a QR and disables expired copying", () => {
    const onCopy = vi.fn();
    render(<ExtensionPairingQr mode="pc" value={value} onCopy={onCopy} onRefresh={() => undefined} onClose={() => undefined} />);
    expect(screen.queryByRole("img")).not.toBeInTheDocument();
    expect(screen.getByText("브라우저에서 Lakomics 확장 아이콘을 눌러 설정을 여세요.")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "링크 복사" }));
    expect(onCopy).toHaveBeenCalledOnce();
    act(() => { vi.advanceTimersByTime(10 * 60 * 1000); });
    expect(screen.getByRole("button", { name: "링크 복사" })).toBeDisabled();
  });

  it("expires locally and leaves refresh available", () => {
    render(<ExtensionPairingQr value={value} onCopy={() => undefined} onRefresh={() => undefined} onClose={() => undefined} />);
    act(() => { vi.advanceTimersByTime(10 * 60 * 1000); });
    expect(screen.getByText("만료")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "링크 복사" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "새로 발급" })).toBeEnabled();
  });

  it("exposes copy refresh and close without rendering the secret as text", () => {
    const onCopy = vi.fn(); const onRefresh = vi.fn(); const onClose = vi.fn();
    const { container } = render(<ExtensionPairingQr value={value} onCopy={onCopy} onRefresh={onRefresh} onClose={onClose} />);
    expect(container.textContent).not.toContain("AAAAAAAAAAAAAAAAAAAA");
    fireEvent.click(screen.getByRole("button", { name: "링크 복사" }));
    fireEvent.click(screen.getByRole("button", { name: "새로 발급" }));
    fireEvent.click(screen.getByRole("button", { name: "닫기" }));
    expect(onCopy).toHaveBeenCalledTimes(1); expect(onRefresh).toHaveBeenCalledTimes(1); expect(onClose).toHaveBeenCalledTimes(1);
  });
});
