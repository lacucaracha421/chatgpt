import { act, cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import type { LibraryGateway, ReleaseCalendar } from "../library/types";
import { EMPTY_EXCHANGE, type ExchangeSnapshot } from "../exchange/exchangeStore";
import { ConnectionStatusBlock } from "./ConnectionStatusBlock";

const transfer = vi.hoisted(() => ({ snapshot: null as ExchangeSnapshot | null }));
vi.mock("../exchange/exchangeStore", async (original) => {
  const actual = await original<typeof import("../exchange/exchangeStore")>();
  return { ...actual, useExchangeSnapshot: () => transfer.snapshot ?? actual.EMPTY_EXCHANGE };
});

afterEach(() => { cleanup(); transfer.snapshot = null; });

it("includes the calendar immediately and keeps the last result across reopening and a failed revalidation", async () => {
  let resolve!: (value: ReleaseCalendar) => void;
  const calendar = vi.fn().mockReturnValueOnce(new Promise<ReleaseCalendar>((done) => { resolve = done; }))
    .mockRejectedValueOnce(new Error("offline"));
  const gateway = { getOnlineCatalogStatus: vi.fn().mockResolvedValue(null), releaseCalendar: { calendar } } as unknown as LibraryGateway;
  const props = { gateway, authorityHealth: null, onNavigate: vi.fn() };
  const first = render(<ConnectionStatusBlock {...props} />);
  const row = screen.getByRole("button", { name: "발매 캘린더 IGDB · TMDB" });
  expect(row).toHaveAttribute("data-tone", "idle");
  await act(async () => resolve({ sources: [{ provider: "igdb", fetchedAt: "2026-10-12T03:00:00Z", errorCode: "offline" }] } as ReleaseCalendar));
  expect(screen.getByRole("button", { name: "발매 캘린더 가져올 수 없음" })).toBe(row);
  const oldText = row.textContent;
  first.unmount();
  render(<ConnectionStatusBlock {...props} />);
  expect(screen.getByRole("button", { name: "발매 캘린더 가져올 수 없음" }).textContent).toBe(oldText);
  await act(async () => {});
  expect(screen.getByRole("button", { name: "발매 캘린더 가져올 수 없음" })).toHaveAttribute("data-tone", "off");
});

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

it("labels the tablet row as 파일 전송 and says when the transfer token is missing", () => {
  const gateway = { getOnlineCatalogStatus: vi.fn().mockResolvedValue(null) } as unknown as LibraryGateway;
  transfer.snapshot = { ...EMPTY_EXCHANGE, availability: { state: "unavailable", message: "토큰", needsToken: true } };
  const view = render(<ConnectionStatusBlock gateway={gateway} authorityHealth={null} onNavigate={vi.fn()} />);
  expect(screen.getByRole("button", { name: "태블릿 전송 토큰 입력 필요" })).toHaveAttribute("data-tone", "idle");
  transfer.snapshot = { ...EMPTY_EXCHANGE, availability: { state: "ready", message: null, needsToken: false }, tokenConfigured: true };
  view.rerender(<ConnectionStatusBlock gateway={gateway} authorityHealth={null} onNavigate={vi.fn()} />);
  expect(screen.getByRole("button", { name: "태블릿 전송 등록된 기기 없음" })).toBeInTheDocument();
  transfer.snapshot = { ...transfer.snapshot, devices: [{ deviceId: "tab", name: "Galaxy Tab", kind: "android" }] };
  view.rerender(<ConnectionStatusBlock gateway={gateway} authorityHealth={null} onNavigate={vi.fn()} />);
  expect(screen.getByRole("button", { name: "태블릿 전송 Galaxy Tab" })).toHaveAttribute("data-tone", "ok");
  transfer.snapshot = { ...EMPTY_EXCHANGE, availability: { state: "unavailable", message: "서버 주소", needsToken: false } };
  view.rerender(<ConnectionStatusBlock gateway={gateway} authorityHealth={null} onNavigate={vi.fn()} />);
  expect(screen.queryByRole("button", { name: /태블릿 전송/ })).toBeNull();
});
