import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { EMPTY_EXCHANGE, ExchangeStore, type ExchangeOutgoing, type ExchangeSnapshot } from "../exchange/exchangeStore";
import { nativeDropClaimed } from "../ingestion/dropClaims";
import type { DropSubscriber, NativeFileDropEvent } from "../ingestion/useFileDrop";
import { HomeTransfer } from "./HomeTransfer";

afterEach(cleanup);

const AT = new Date(2026, 9, 15, 22, 0);
const out = (id: string, fields: Partial<ExchangeOutgoing> = {}): ExchangeOutgoing => ({ transferId: id, fileName: `${id}.png`, sizeBytes: 100, toName: "Tab", state: "delivered", done: 0, message: null, note: null, retryable: false, cancellable: false, createdAt: new Date(2026, 9, 15, 21, 40).toISOString(), ...fields });
const ready = (extra: Partial<ExchangeSnapshot> = {}): ExchangeSnapshot => ({ ...EMPTY_EXCHANGE, availability: { state: "ready", message: null, needsToken: false }, selfName: "PC", devices: [{ deviceId: "tab", name: "Galaxy Tab", kind: "tablet" }], ...extra });

function setup(snapshot: ExchangeSnapshot, props: Partial<Parameters<typeof HomeTransfer>[0]> = {}) {
  const request = vi.fn(async (command: string) => (command === "exchange_snapshot" ? snapshot : 1) as never);
  const store = new ExchangeStore(request, async () => () => undefined);
  let drops!: (event: NativeFileDropEvent) => void;
  const subscribeDrops: DropSubscriber = async (handler) => { drops = handler; return () => undefined; };
  const onOpenDetail = vi.fn();
  const view = render(<HomeTransfer at={AT} enabled store={store} subscribeDrops={subscribeDrops} onOpenDetail={onOpenDetail} {...props} />);
  const tile = screen.getByRole("region", { name: "전송" });
  vi.spyOn(tile, "getBoundingClientRect").mockReturnValue({ left: 100, top: 100, right: 400, bottom: 400, width: 300, height: 300, x: 100, y: 100, toJSON: () => ({}) });
  return { request, store, onOpenDetail, view, tile, drop: (event: NativeFileDropEvent) => act(() => drops(event)), subscribed: () => waitFor(() => expect(drops).toBeDefined()) };
}
const sendCalls = (request: ReturnType<typeof setup>["request"]) => request.mock.calls.filter(([command]) => command === "exchange_send");

it("sends what is dropped on the tile to the paired tablet through the exchange store, with no prompt", async () => {
  const { request, drop, subscribed } = setup(ready());
  await screen.findByRole("button", { name: "놓으면 Galaxy Tab(으)로 보냅니다" });
  await subscribed();
  drop({ type: "drop", paths: ["C:\a.png", "C:\b.zip"], position: { x: 200, y: 200 } });
  await waitFor(() => expect(sendCalls(request)).toHaveLength(1));
  expect(request).toHaveBeenCalledWith("exchange_send", { paths: ["C:\a.png", "C:\b.zip"], toDevice: "tab" });
});

it("ignores a drop outside the tile and while the Home area is hidden", async () => {
  const outside = setup(ready());
  await screen.findByRole("button", { name: "놓으면 Galaxy Tab(으)로 보냅니다" });
  await outside.subscribed();
  outside.drop({ type: "drop", paths: ["C:\a.png"], position: { x: 10, y: 10 } });
  expect(sendCalls(outside.request)).toHaveLength(0);
  cleanup();
  const hidden = setup(ready(), { enabled: false });
  await screen.findByRole("button", { name: "놓으면 Galaxy Tab(으)로 보냅니다" });
  await hidden.subscribed();
  hidden.drop({ type: "drop", paths: ["C:\a.png"], position: { x: 200, y: 200 } });
  expect(sendCalls(hidden.request)).toHaveLength(0);
});

it("shows the dashed drop state only while a drag is over the tile", async () => {
  const { tile, drop, subscribed } = setup(ready());
  await screen.findByRole("button", { name: "놓으면 Galaxy Tab(으)로 보냅니다" });
  await subscribed();
  expect(tile).not.toHaveAttribute("data-over");
  drop({ type: "enter", paths: ["C:\a.png"], position: { x: 200, y: 200 } });
  expect(tile).toHaveAttribute("data-over");
  drop({ type: "over", position: { x: 10, y: 10 } });
  expect(tile).not.toHaveAttribute("data-over");
  drop({ type: "over", position: { x: 300, y: 300 } });
  expect(tile).toHaveAttribute("data-over");
  drop({ type: "leave" });
  expect(tile).not.toHaveAttribute("data-over");
});

it("claims the area against the app-wide import while mounted", async () => {
  const { view } = setup(ready());
  expect(nativeDropClaimed({ x: 200, y: 200 })).toBe(true);
  expect(nativeDropClaimed({ x: 10, y: 10 })).toBe(false);
  view.unmount();
  expect(nativeDropClaimed({ x: 200, y: 200 })).toBe(false);
});

it("gives the existing reason and sends nothing when there is no tablet or sending is unavailable", async () => {
  const none = setup(ready({ devices: [] }));
  expect(await screen.findByRole("button", { name: "받을 기기가 없습니다" })).toBeTruthy();
  expect(screen.getByRole("button", { name: /받을 기기가 없습니다/ })).toBeDisabled();
  await none.subscribed();
  none.drop({ type: "drop", paths: ["C:\a.png"], position: { x: 200, y: 200 } });
  expect(sendCalls(none.request)).toHaveLength(0);
  cleanup();
  setup(ready({ availability: { state: "unavailable", message: "토큰이 필요합니다", needsToken: true } }));
  expect(await screen.findByRole("button", { name: "토큰이 필요합니다" })).toBeTruthy();
});

it("says nothing about a reason while the connection is still starting", () => {
  setup(EMPTY_EXCHANGE);
  expect(screen.getByRole("button", { name: /파일을 놓아 보내기/ })).toBeDisabled();
  expect(screen.queryByRole("button", { name: "받을 기기가 없습니다" })).toBeNull();
});

it("lists the last three sends with their route, progress or time, and opens the detail screen", async () => {
  const rows = [
    out("old", { createdAt: new Date(2026, 9, 14, 9, 5).toISOString() }),
    out("done", { createdAt: new Date(2026, 9, 15, 21, 40).toISOString() }),
    out("busy", { state: "uploading", sizeBytes: 200, done: 100, createdAt: new Date(2026, 9, 15, 21, 50).toISOString() }),
    out("wait", { state: "waiting", createdAt: new Date(2026, 9, 15, 21, 45).toISOString() }),
  ];
  const { onOpenDetail } = setup(ready({ outgoing: rows }));
  const tile = screen.getByRole("region", { name: "전송" });
  await within(tile).findByText("busy.png");
  expect(within(tile).queryByText("old.png")).toBeNull();
  expect(within(tile).getByText("서버 · 50%")).toBeTruthy();
  expect(within(tile).getByText("서버 · 받기 대기")).toBeTruthy();
  expect(within(tile).getByText("서버 · 21:40")).toBeTruthy();
  expect(await within(tile).findByRole("progressbar", { name: "busy.png 진행률" })).toHaveAttribute("aria-valuenow", "50");
  await userEvent.click(within(tile).getByRole("button", { name: /상세/ }));
  expect(onOpenDetail).toHaveBeenCalledOnce();
});

it("picks files by click and reports a failed send on the tile", async () => {
  const pickFiles = vi.fn().mockResolvedValue(["C:\c.png"]);
  const { request } = setup(ready(), { pickFiles });
  await userEvent.click(await screen.findByRole("button", { name: /Galaxy Tab/ }));
  await waitFor(() => expect(request).toHaveBeenCalledWith("exchange_send", { paths: ["C:\c.png"], toDevice: "tab" }));
  request.mockImplementation(async (command: string) => { if (command === "exchange_send") throw new Error("서버에 연결할 수 없습니다"); return ready() as never; });
  await userEvent.click(screen.getByRole("button", { name: /Galaxy Tab/ }));
  expect(await screen.findByRole("alert")).toHaveTextContent("서버에 연결할 수 없습니다");
});
