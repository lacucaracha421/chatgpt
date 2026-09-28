import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import type { LibraryGateway } from "../library/types";
import { ConnectionStatusBlock } from "./ConnectionStatusBlock";

afterEach(cleanup);

it("lists server, catalog and 발매 캘린더 state and opens the screen that owns each", async () => {
  const gateway = {
    getOnlineCatalogStatus: vi.fn().mockResolvedValue({ installed: true, lastSuccessAt: null, lastError: "boom" }),
    releaseCalendar: { calendar: vi.fn().mockResolvedValue({ rangeStart: "", rangeEnd: "", entries: [], sources: [{ provider: "igdb", fetchedAt: null, attemptedAt: null, errorCode: null, due: false }] }) },
  } as unknown as LibraryGateway;
  const onNavigate = vi.fn();
  render(<ConnectionStatusBlock gateway={gateway} authorityHealth={{ authorityPassFailure: { code: "network", at: "2026-09-28T05:31:00Z" } } as never} onNavigate={onNavigate} />);
  const block = screen.getByRole("region", { name: "연결" });
  expect(within(block).getByRole("button", { name: "서버 연결 안 됨" })).toHaveAttribute("data-tone", "off");
  expect(await within(block).findByRole("button", { name: "카탈로그 갱신 실패" })).toHaveAttribute("data-tone", "off");
  await userEvent.click(await within(block).findByRole("button", { name: "발매 캘린더 IGDB · TMDB" }));
  expect(onNavigate).toHaveBeenLastCalledWith({ kind: "settings", section: "connection" });
});
