import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { SettingsGroup, SettingsRow } from "./SettingsRow";

afterEach(cleanup);

it("keeps the shared settings group and PC row structure", () => {
  render(
    <SettingsGroup title="연결">
      <SettingsRow name="서버" value="https://example.invalid" status="연결됨" tone="ok" control={<button type="button">연결 변경</button>} />
    </SettingsGroup>,
  );

  const row = screen.getByText("서버").closest("dl");
  expect(screen.getByRole("heading", { name: "연결" })).toBeInTheDocument();
  expect(row).toHaveClass("settings-view__property");
  expect(row?.querySelector("dt .settings-view__value")).toHaveTextContent("https://example.invalid");
  expect(row?.querySelector(".settings-view__status")).toHaveAttribute("data-tone", "ok");
  expect(screen.getByRole("button", { name: "연결 변경" })).toBeInTheDocument();
});
