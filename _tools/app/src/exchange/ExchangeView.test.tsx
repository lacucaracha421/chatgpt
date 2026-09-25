import { act, cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { ChromeTarget, WorkspaceChromeProvider } from "../layout/WorkspaceChrome";
import type { NativeFileDropEvent } from "../ingestion/useFileDrop";
import { ExchangeView, outgoingLabel } from "./ExchangeView";
import { EMPTY_EXCHANGE, ExchangeStore, type ExchangeOutgoing, type ExchangeSnapshot } from "./exchangeStore";

afterEach(cleanup);

const tablet = { deviceId: "d1", name: "Galaxy Tab S11", kind: "android" };
const row = (patch: Partial<ExchangeOutgoing>): ExchangeOutgoing => ({
  transferId: "t", fileName: "a.jpg", sizeBytes: 1000, toName: "Galaxy Tab S11", state: "waiting", done: 0,
  message: null, note: null, retryable: false, cancellable: true, createdAt: null, ...patch,
});

function setup(initial: Partial<ExchangeSnapshot>) {
  let push: (next: ExchangeSnapshot) => void = () => undefined;
  const calls: [string, Record<string, unknown> | undefined][] = [];
  const snapshot: ExchangeSnapshot = { ...EMPTY_EXCHANGE, availability: { state: "ready", message: null, needsToken: false }, ...initial };
  const request = vi.fn(async (command: string, args?: Record<string, unknown>) => {
    calls.push([command, args]);
    return command === "exchange_snapshot" ? snapshot : undefined;
  });
  const store = new ExchangeStore(request as never, async (handler) => { push = handler; return () => undefined; });
  let drop: (event: NativeFileDropEvent) => void = () => undefined;
  const pick = vi.fn(async () => ["/home/me/a.jpg", "/home/me/b.mp4"]);
  const pickFolder = vi.fn(async () => ["/home/me/사진"]);
  render(<WorkspaceChromeProvider scope="exchange"><ChromeTarget name="navigation" /><ExchangeView store={store} pickFiles={pick} pickFolder={pickFolder}
    subscribeDrops={async (handler) => { drop = handler; return () => undefined; }} /></WorkspaceChromeProvider>);
  return { calls, pick, pickFolder, push: (next: Partial<ExchangeSnapshot>) => act(() => push({ ...snapshot, ...next })), drop: (event: NativeFileDropEvent) => act(() => drop(event)) };
}

it("labels every outgoing state in Korean", () => {
  expect(outgoingLabel(row({ state: "uploading", done: 500 }))).toBe("업로드 중 50%");
  expect(outgoingLabel(row({ state: "zipping", done: 250 }))).toBe("압축 중 25%");
  expect(outgoingLabel(row({ state: "waiting" }))).toBe("대기 중 (받으면 삭제됨)");
  expect(outgoingLabel(row({ state: "delivered" }))).toBe("전달됨");
  expect(outgoingLabel(row({ state: "expired" }))).toBe("만료됨 (받지 않음)");
  expect(outgoingLabel(row({ state: "failed", message: "보관 한도 초과" }))).toBe("실패 · 보관 한도 초과");
  expect(outgoingLabel(row({ state: "queued", message: "서버에 연결할 수 없음 — 자동 재시도" }))).toBe("서버에 연결할 수 없음 — 자동 재시도");
});

it("sends picked and dropped files to the only other device", async () => {
  const view = setup({ devices: [tablet] });
  await userEvent.click(await screen.findByRole("button", { name: "파일 보내기" }));
  expect(view.pick).toHaveBeenCalled();
  expect(view.calls).toContainEqual(["exchange_send", { paths: ["/home/me/a.jpg", "/home/me/b.mp4"], toDevice: "d1" }]);
  view.drop({ type: "drop", paths: ["/tmp/c.zip"], position: { x: 0, y: 0 } });
  await vi.waitFor(() => expect(view.calls).toContainEqual(["exchange_send", { paths: ["/tmp/c.zip"], toDevice: "d1" }]));
});

it("asks for a target when several devices exist", async () => {
  setup({ devices: [tablet, { deviceId: "d2", name: "Phone", kind: "android" }] });
  expect(await screen.findByRole("button", { name: "파일 보내기" })).toBeDisabled();
  await userEvent.selectOptions(screen.getByRole("combobox", { name: "받는 기기" }), "d2");
  expect(screen.getByRole("button", { name: "파일 보내기" })).toBeEnabled();
});

it("shows progress, retry and cancel per row", async () => {
  const view = setup({ devices: [tablet] });
  view.push({ devices: [tablet], outgoing: [
    row({ transferId: "up", state: "uploading", done: 250 }),
    row({ transferId: "bad", fileName: "big.iso", state: "failed", message: "보관 한도 초과", retryable: true }),
  ] });
  const list = screen.getByRole("list", { name: "보낸 파일" });
  expect(within(list).getByRole("progressbar", { name: "a.jpg 진행률" })).toHaveAttribute("aria-valuenow", "25");
  expect(within(list).getByText("실패 · 보관 한도 초과")).toBeInTheDocument();
  await userEvent.click(within(list).getByRole("button", { name: "재시도" }));
  expect(view.calls).toContainEqual(["exchange_retry", { transferId: "bad" }]);
  await userEvent.click(within(list).getAllByRole("button", { name: "취소" })[0]);
  expect(view.calls).toContainEqual(["exchange_cancel", { transferId: "up" }]);
});

it("lists received files with open and reveal, and marks them seen", async () => {
  const view = setup({ devices: [tablet] });
  view.push({ unseen: 1, received: [{ transferId: "r1", fileName: "photo (1).jpg", sizeBytes: 2048, fromName: "Galaxy Tab S11", receivedAt: "2026-09-25T01:00:00Z", exists: true }] });
  const list = screen.getByRole("list", { name: "받은 파일" });
  await userEvent.click(within(list).getByRole("button", { name: "열기" }));
  await userEvent.click(within(list).getByRole("button", { name: "폴더에서 보기" }));
  expect(view.calls).toContainEqual(["exchange_open", { transferId: "r1" }]);
  expect(view.calls).toContainEqual(["exchange_reveal", { transferId: "r1" }]);
  expect(view.calls.some(([command]) => command === "exchange_mark_seen")).toBe(true);
});

it("explains a shared token and accepts this PC's own token", async () => {
  const view = setup({});
  view.push({ availability: { state: "unavailable", message: "이 PC 전용 토큰이 필요합니다. 공용 클라우드 토큰으로는 보내기/받기를 쓸 수 없습니다.", needsToken: true } });
  expect(screen.getByRole("alert")).toHaveTextContent("이 PC 전용 토큰이 필요합니다");
  await userEvent.type(screen.getByLabelText("이 PC 전용 토큰"), "device-token");
  await userEvent.click(screen.getByRole("button", { name: "저장" }));
  expect(view.calls).toContainEqual(["exchange_set_token", { token: "device-token" }]);
});

it("sends a picked folder and shows zipping progress with a note", async () => {
  const view = setup({ devices: [tablet] });
  await userEvent.click(await screen.findByRole("button", { name: "폴더 보내기" }));
  expect(view.pickFolder).toHaveBeenCalled();
  expect(view.calls).toContainEqual(["exchange_send", { paths: ["/home/me/사진"], toDevice: "d1" }]);
  view.push({ devices: [tablet], outgoing: [row({ transferId: "z", fileName: "사진.zip", state: "zipping", done: 500, note: "읽지 못한 항목 2개 제외" })] });
  const list = screen.getByRole("list", { name: "보낸 파일" });
  expect(within(list).getByText("압축 중 50%")).toBeInTheDocument();
  expect(within(list).getByText(/읽지 못한 항목 2개 제외/)).toBeInTheDocument();
  await userEvent.click(within(list).getByRole("button", { name: "취소" }));
  expect(view.calls).toContainEqual(["exchange_cancel", { transferId: "z" }]);
});
