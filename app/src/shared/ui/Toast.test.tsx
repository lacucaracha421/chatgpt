import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { Toast } from "./Toast";
import { useAutoDismiss } from "./useAutoDismiss";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

it("exposes the full message and dismisses a polite status", async () => {
  const onDismiss = vi.fn();
  const user = userEvent.setup();
  render(<Toast onDismiss={onDismiss}>very-long-notification-message</Toast>);

  const toast = screen.getByRole("status");
  const message = screen.getByText("very-long-notification-message");
  expect(message).toHaveClass("ui-toast__message");
  expect(toast.closest(".ui-toast-region")?.parentElement).toBe(document.body);
  expect(message).toHaveAttribute("title", "very-long-notification-message");
  await user.click(screen.getByRole("button", { name: "알림 닫기" }));
  expect(onDismiss).toHaveBeenCalledOnce();
});
it("uses an assertive alert role for errors", () => {
  render(<Toast tone="error">failed</Toast>);
  expect(screen.getByRole("alert")).toHaveTextContent("failed");
});

it("pauses auto-dismiss while the toast is being hovered", () => {
  vi.useFakeTimers();
  render(<AutoDismissHarness />);
  const toast = screen.getByRole("status");

  act(() => vi.advanceTimersByTime(4_000));
  fireEvent.pointerEnter(toast);
  act(() => vi.advanceTimersByTime(3_000));
  expect(screen.getByRole("status")).toBeInTheDocument();

  fireEvent.pointerLeave(toast);
  act(() => vi.advanceTimersByTime(999));
  expect(screen.getByRole("status")).toBeInTheDocument();
  act(() => vi.advanceTimersByTime(1));
  expect(screen.queryByRole("status")).not.toBeInTheDocument();
});

function AutoDismissHarness({ dismissible = false }: { dismissible?: boolean }) {
  const [message, setMessage] = useState<string | null>("saved");
  useAutoDismiss(message, setMessage);
  return message ? <Toast onDismiss={dismissible ? () => setMessage(null) : undefined}>{message}</Toast> : null;
}

it("pauses auto-dismiss while focus stays inside the toast", () => {
  vi.useFakeTimers();
  render(<AutoDismissHarness dismissible />);
  const close = screen.getByRole("button", { name: "알림 닫기" });

  act(() => vi.advanceTimersByTime(4_500));
  fireEvent.focus(close);
  act(() => vi.advanceTimersByTime(2_000));
  expect(screen.getByRole("status")).toBeInTheDocument();

  fireEvent.blur(close, { relatedTarget: null });
  act(() => vi.advanceTimersByTime(499));
  expect(screen.getByRole("status")).toBeInTheDocument();
  act(() => vi.advanceTimersByTime(1));
  expect(screen.queryByRole("status")).not.toBeInTheDocument();
});
