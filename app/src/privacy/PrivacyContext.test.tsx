import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { PrivacyProvider, usePrivacy } from "./PrivacyContext";

function Probe() {
  const { privacyMode, setPrivacyMode } = usePrivacy();
  return (
    <button
      type="button"
      aria-label="프라이버시 상태"
      aria-pressed={privacyMode}
      onClick={() => setPrivacyMode(!privacyMode)}
    >
      {privacyMode ? "가림" : "보임"}
    </button>
  );
}

afterEach(cleanup);

it("defaults to unmasked with a no-op setter", () => {
  render(<Probe />);

  const button = screen.getByRole("button", { name: "프라이버시 상태" });
  expect(button).toHaveAttribute("aria-pressed", "false");
  expect(screen.getByText("보임")).toBeVisible();
});

it("shares privacy mode from the provider and round-trips changes", async () => {
  const user = userEvent.setup();
  const setPrivacyMode = vi.fn();
  render(
    <PrivacyProvider privacyMode setPrivacyMode={setPrivacyMode}>
      <Probe />
    </PrivacyProvider>,
  );

  expect(screen.getByText("가림")).toBeVisible();
  await user.click(screen.getByRole("button", { name: "프라이버시 상태" }));
  expect(setPrivacyMode).toHaveBeenCalledWith(false);
});