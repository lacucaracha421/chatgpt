import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { LibraryProvider } from "../library/LibraryContext";
import { libraryGateway } from "../library/client";
import { DateBrowse } from "./DateBrowse";

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));

beforeEach(() => {
  invoke.mockReset();
  invoke.mockImplementation((command: string) => command === "list_asset_date_buckets"
    ? Promise.resolve([{ date: "2026-08-03", count: 2 }, { date: "2026-08-06", count: 3 }])
    : Promise.resolve(undefined));
});

afterEach(cleanup);

it("starts with the month expanded and collapses to the selected day", async () => {
  const user = userEvent.setup();
  render(
    <LibraryProvider gateway={libraryGateway}>
      <DateBrowse initialMonth="2026-08" />
    </LibraryProvider>,
  );

  expect(await screen.findByRole("heading", { name: "2026년 8월 · 5개 · 2일 저장" })).toBeVisible();
  await user.click(screen.getByRole("button", { name: "2026-08-06 수집 3개" }));

  expect(screen.getByRole("heading", { name: "2026년 8월 6일" })).toBeVisible();
  expect(screen.getByRole("button", { name: "달력 펼치기" })).toBeVisible();
});

it("moves between populated days and skips empty dates", async () => {
  const user = userEvent.setup();
  render(
    <LibraryProvider gateway={libraryGateway}>
      <DateBrowse initialMonth="2026-08" />
    </LibraryProvider>,
  );

  await user.click(await screen.findByRole("button", { name: "2026-08-06 수집 3개" }));
  await user.click(screen.getByRole("button", { name: "이전 저장일" }));

  expect(screen.getByRole("heading", { name: "2026년 8월 3일" })).toBeVisible();
  expect(screen.getByRole("button", { name: "이전 저장일" })).toBeDisabled();
});
