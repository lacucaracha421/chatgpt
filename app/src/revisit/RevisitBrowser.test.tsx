import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, it, vi } from "vitest";
import { LibraryProvider } from "../library/LibraryContext";
import { libraryGateway } from "../library/client";
import { RevisitBrowser } from "./RevisitBrowser";

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));

beforeEach(() => {
  invoke.mockReset();
  invoke.mockResolvedValue([]);
});

it("switches from 오늘 to 날짜와 작가가 있는 둘러보기", async () => {
  const user = userEvent.setup();
  render(
    <LibraryProvider gateway={libraryGateway}>
      <RevisitBrowser />
    </LibraryProvider>,
  );

  expect(screen.getByRole("tab", { name: "오늘", selected: true })).toBeVisible();
  await user.click(screen.getByRole("tab", { name: "둘러보기" }));
  expect(screen.getByRole("tab", { name: "날짜", selected: true })).toBeVisible();
  expect(screen.getByRole("tab", { name: "작가" })).toBeVisible();
});
