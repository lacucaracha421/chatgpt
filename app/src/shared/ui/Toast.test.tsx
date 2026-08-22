import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { Toast } from "./Toast";

afterEach(cleanup);

it("exposes the full truncated message and dismisses it", async () => {
  const onDismiss = vi.fn();
  const user = userEvent.setup();
  render(<Toast onDismiss={onDismiss}>very-long-notification-message</Toast>);

  const message = screen.getByText("very-long-notification-message");
  expect(message).toHaveClass("ui-toast__message");
  expect(message.closest(".ui-toast-region")).toBeInTheDocument();
  expect(message.closest(".ui-toast-region")?.parentElement).toBe(document.body);
  expect(message).toHaveAttribute("title", "very-long-notification-message");
  await user.click(screen.getByRole("button", { name: "알림 닫기" }));
  expect(onDismiss).toHaveBeenCalledOnce();
});
