import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { DirectReceiveBlock } from "./DirectReceive";
import { EMPTY_EXCHANGE, ExchangeStore, useExchangeSnapshot, type DirectReceive, type OpenFirewallOutcome } from "./exchangeStore";

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { cleanup(); vi.useRealTimers(); });

type OpenResult = { outcome: OpenFirewallOutcome; state: DirectReceive };

function setup(first: DirectReceive, opens: (OpenResult | Promise<OpenResult>)[] = []) {
  const queue = [...opens];
  const request = vi.fn(async (command: string) => {
    if (command === "exchange_snapshot") return EMPTY_EXCHANGE as never;
    if (command === "exchange_open_firewall") return (await queue.shift()) as never;
    if (command === "exchange_direct_receive_status") return first as never;
    return undefined as never;
  });
  const store = new ExchangeStore(request, async () => () => undefined);
  store.setDirectReceive(first);
  function Harness() {
    const snapshot = useExchangeSnapshot(store);
    return <DirectReceiveBlock store={store} state={snapshot.directReceive ?? "unknown"} hasDevice />;
  }
  const view = render(<Harness />);
  const opened = () => request.mock.calls.filter(([command]) => command === "exchange_open_firewall").length;
  const settle = (ms = 0) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });
  return { view, request, store, opened, settle };
}

const button = (name: string) => screen.getByRole("button", { name });

it("shows nothing while unknown, allowed or unsupported", () => {
  for (const state of ["unknown", "allowed", "unsupported"] as const) {
    const { view } = setup(state);
    expect(screen.queryByText("직접 받기")).toBeNull();
    expect(view.container).toBeEmptyDOMElement();
    cleanup();
  }
});

it("explains a Public network without offering the button", () => {
  setup("public");
  expect(screen.getByRole("status")).toHaveTextContent("공용 네트워크라 서버를 거쳐 받음");
  expect(screen.queryByRole("button", { name: "방화벽 열기" })).toBeNull();
  expect(screen.getByRole("button", { name: "직접 받기 도움말" })).toBeTruthy();
});

it("opens once per click, confirms in place, then folds away", async () => {
  let finish!: (value: OpenResult) => void;
  const pending = new Promise<OpenResult>((resolve) => { finish = resolve; });
  const { opened, settle } = setup("blocked", [pending]);
  expect(screen.getByRole("status")).toHaveTextContent("지금은 서버를 거쳐 받음");
  fireEvent.click(button("방화벽 열기"));
  fireEvent.click(button("방화벽 열기"));
  await settle();
  expect(opened()).toBe(1);
  expect(button("방화벽 열기")).toBeDisabled();
  // The busy label waits (no blink for quick work), then shows.
  await settle(300);
  expect(screen.queryByText("여는 중")).toBeNull();
  await settle(400);
  expect(screen.getByText("여는 중")).toBeTruthy();
  finish({ outcome: "opened", state: "allowed" });
  await settle();
  expect(screen.getByRole("status")).toHaveTextContent("열림");
  expect(screen.queryByRole("button", { name: /방화벽 열기|여는 중/ })).toBeNull();
  await settle(1000);
  expect(screen.getByRole("status")).toHaveTextContent("열림");
  // Held 1.2 s, then it collapses (each step in its own act so React schedules the collapse timer in between).
  await settle(300);
  await settle(300);
  expect(screen.queryByText("직접 받기")).toBeNull();
});

it("goes quietly back to blocked when the administrator prompt is declined", async () => {
  const { settle, opened } = setup("blocked", [{ outcome: "cancelled", state: "blocked" }, { outcome: "opened", state: "allowed" }]);
  fireEvent.click(button("방화벽 열기"));
  await settle();
  expect(screen.getByRole("status")).toHaveTextContent("지금은 서버를 거쳐 받음");
  expect(screen.getByRole("button", { name: "방화벽 열기" })).toBeEnabled();
  fireEvent.click(button("방화벽 열기"));
  await settle();
  expect(opened()).toBe(2);
});

it("reports a failure in one line and lets the user try again", async () => {
  const { settle } = setup("blocked", [{ outcome: "failed", state: "blocked" }, { outcome: "opened", state: "allowed" }]);
  fireEvent.click(button("방화벽 열기"));
  await settle();
  expect(screen.getByRole("status")).toHaveTextContent("방화벽을 열지 못함");
  fireEvent.click(button("다시 시도"));
  await settle();
  expect(screen.getByRole("status")).toHaveTextContent("열림");
  await settle(1300);
  await settle(300);
  expect(screen.queryByText("직접 받기")).toBeNull();
});
