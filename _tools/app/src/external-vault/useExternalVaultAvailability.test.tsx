import { act, cleanup, render, renderHook, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { AssetView, EncryptedVaultStatus, LibraryGateway } from "../library/types";
import { useExternalVaultAvailability, VAULT_OPEN_POLL_MS, type VaultLeaveReason, type VaultMountSubscription } from "./useExternalVaultAvailability";

const workload = vi.hoisted(() => ({ hidden: false, restricted: false }));
vi.mock("../app/workloadProfile", () => ({ useWorkloadProfile: () => workload }));
afterEach(() => { cleanup(); vi.useRealTimers(); workload.hidden = false; workload.restricted = false; });

const unlocked: EncryptedVaultStatus = { state: "unlocked", vaultId: "vault-1", root: "/vault", itemCount: 3, remembered: true };
const locked: EncryptedVaultStatus = { ...unlocked, state: "locked", itemCount: null };
const absent: EncryptedVaultStatus = { state: "absent", vaultId: null, root: null, itemCount: null, remembered: false };

/** Stands in for the native `external-vault-changed` event. */
function mountEvents() {
  const handlers = new Set<() => void>();
  const subscribe = vi.fn<VaultMountSubscription>((handler) => {
    handlers.add(handler);
    return () => { handlers.delete(handler); };
  });
  return { subscribe, handlers, fire: () => handlers.forEach(handler => handler()) };
}

const noMountEvents: VaultMountSubscription = () => () => {};

function Harness({ gateway, view, onLeave, subscribeMountChanges = noMountEvents }: {
  gateway: Pick<LibraryGateway, "getEncryptedVaultStatus">;
  view: AssetView;
  onLeave: (reason: VaultLeaveReason) => void;
  subscribeMountChanges?: VaultMountSubscription;
}) {
  const { status } = useExternalVaultAvailability({ gateway, view, onLeave, subscribeMountChanges });
  return <span>{status?.state ?? "loading"}</span>;
}

const library: AssetView = { kind: "classification", classificationId: null };

it("loads status at startup and refreshes it on focus", async () => {
  const getEncryptedVaultStatus = vi.fn().mockResolvedValueOnce(unlocked).mockResolvedValueOnce(absent);
  render(<Harness gateway={{ getEncryptedVaultStatus }} view={{ kind: "classification", classificationId: null }} onLeave={vi.fn()} />);

  await waitFor(() => expect(screen.getByText("unlocked")).toBeInTheDocument());
  expect(getEncryptedVaultStatus).toHaveBeenCalledTimes(1);

  act(() => window.dispatchEvent(new Event("focus")));
  await waitFor(() => expect(screen.getByText("absent")).toBeInTheDocument());
  expect(getEncryptedVaultStatus).toHaveBeenCalledTimes(2);
});

it("does not poll while idle and reads the status once per mount change event", async () => {
  vi.useFakeTimers();
  const events = mountEvents();
  const getEncryptedVaultStatus = vi.fn().mockResolvedValueOnce(absent).mockResolvedValue(locked);
  render(<Harness gateway={{ getEncryptedVaultStatus }} view={library} onLeave={vi.fn()} subscribeMountChanges={events.subscribe} />);
  await act(async () => { await vi.advanceTimersByTimeAsync(0); });
  expect(screen.getByText("absent")).toBeInTheDocument();

  await act(async () => { await vi.advanceTimersByTimeAsync(10 * 60_000); });
  expect(getEncryptedVaultStatus).toHaveBeenCalledTimes(1);

  await act(async () => { events.fire(); await vi.advanceTimersByTimeAsync(0); });
  expect(getEncryptedVaultStatus).toHaveBeenCalledTimes(2);
  expect(screen.getByText("locked")).toBeInTheDocument();

  await act(async () => { await vi.advanceTimersByTimeAsync(10 * 60_000); });
  expect(getEncryptedVaultStatus).toHaveBeenCalledTimes(2);

  Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
  try {
    await act(async () => { events.fire(); await vi.advanceTimersByTimeAsync(0); });
    expect(getEncryptedVaultStatus).toHaveBeenCalledTimes(2);
  } finally {
    Reflect.deleteProperty(document, "visibilityState");
  }
});

it("unsubscribes from mount events on unmount and while the app is hidden", () => {
  const events = mountEvents();
  const getEncryptedVaultStatus = vi.fn().mockResolvedValue(absent);
  const gateway = { getEncryptedVaultStatus };
  const { rerender, unmount } = render(<Harness gateway={gateway} view={library} onLeave={vi.fn()} subscribeMountChanges={events.subscribe} />);
  expect(events.handlers.size).toBe(1);
  workload.hidden = true;
  rerender(<Harness gateway={gateway} view={library} onLeave={vi.fn()} subscribeMountChanges={events.subscribe} />);
  expect(events.handlers.size).toBe(0);
  workload.hidden = false;
  rerender(<Harness gateway={gateway} view={library} onLeave={vi.fn()} subscribeMountChanges={events.subscribe} />);
  expect(events.handlers.size).toBe(1);
  unmount();
  expect(events.handlers.size).toBe(0);
});

it("leaves an unlocked secret view when a mount change event reports the USB gone", async () => {
  vi.useFakeTimers();
  const events = mountEvents();
  const onLeave = vi.fn();
  const getEncryptedVaultStatus = vi.fn().mockResolvedValueOnce(unlocked).mockResolvedValueOnce(absent);
  render(<Harness gateway={{ getEncryptedVaultStatus }} view={{ kind: "private_vault" }} onLeave={onLeave} subscribeMountChanges={events.subscribe} />);
  await act(async () => { await vi.advanceTimersByTimeAsync(0); });
  expect(screen.getByText("unlocked")).toBeInTheDocument();

  await act(async () => { events.fire(); await vi.advanceTimersByTimeAsync(0); });
  expect(getEncryptedVaultStatus).toHaveBeenCalledTimes(2);
  expect(onLeave).toHaveBeenCalledExactlyOnceWith("disconnected");
});

it("polls only while the secret view shows an unlocked vault", async () => {
  vi.useFakeTimers();
  const getEncryptedVaultStatus = vi.fn()
    .mockResolvedValueOnce(unlocked)
    .mockResolvedValueOnce(unlocked)
    .mockResolvedValueOnce(absent)
    .mockResolvedValue(absent);
  const onLeave = vi.fn();
  const gateway = { getEncryptedVaultStatus };
  const { rerender } = render(<Harness gateway={gateway} view={library} onLeave={onLeave} />);
  await act(async () => { await vi.advanceTimersByTimeAsync(VAULT_OPEN_POLL_MS * 5); });
  expect(getEncryptedVaultStatus).toHaveBeenCalledTimes(1);

  rerender(<Harness gateway={gateway} view={{ kind: "private_vault" }} onLeave={onLeave} />);
  await act(async () => { await vi.advanceTimersByTimeAsync(VAULT_OPEN_POLL_MS); });
  expect(getEncryptedVaultStatus).toHaveBeenCalledTimes(2);
  expect(onLeave).not.toHaveBeenCalled();

  // A removed USB whose mount lingered is still noticed by the open view, which then closes.
  await act(async () => { await vi.advanceTimersByTimeAsync(VAULT_OPEN_POLL_MS); });
  expect(getEncryptedVaultStatus).toHaveBeenCalledTimes(3);
  expect(onLeave).toHaveBeenCalledWith("disconnected");

  await act(async () => { await vi.advanceTimersByTimeAsync(VAULT_OPEN_POLL_MS * 5); });
  expect(getEncryptedVaultStatus).toHaveBeenCalledTimes(3);
});

it("leaves an open secret view when the USB disappears", async () => {
  const onLeave = vi.fn();
  const getEncryptedVaultStatus = vi.fn().mockResolvedValueOnce(unlocked).mockResolvedValueOnce(absent);
  render(<Harness gateway={{ getEncryptedVaultStatus }} view={{ kind: "private_vault" }} onLeave={onLeave} />);

  await waitFor(() => expect(screen.getByText("unlocked")).toBeInTheDocument());
  expect(onLeave).not.toHaveBeenCalled();
  act(() => window.dispatchEvent(new Event("focus")));
  await waitFor(() => expect(onLeave).toHaveBeenCalledWith("disconnected"));
});

it("leaves an open secret view when the vault is locked, but not when it starts locked", async () => {
  const onLeave = vi.fn();
  const getEncryptedVaultStatus = vi.fn().mockResolvedValueOnce(locked).mockResolvedValueOnce(unlocked).mockResolvedValueOnce(locked);
  render(<Harness gateway={{ getEncryptedVaultStatus }} view={{ kind: "private_vault" }} onLeave={onLeave} />);

  await waitFor(() => expect(screen.getByText("locked")).toBeInTheDocument());
  act(() => window.dispatchEvent(new Event("focus")));
  await waitFor(() => expect(screen.getByText("unlocked")).toBeInTheDocument());
  expect(onLeave).not.toHaveBeenCalled();
  act(() => window.dispatchEvent(new Event("focus")));
  await waitFor(() => expect(onLeave).toHaveBeenCalledWith("locked"));
});

it("clears unlocked state on hide before any delayed foreground refresh", async () => {
  const onLeave = vi.fn();
  const getEncryptedVaultStatus = vi.fn().mockResolvedValueOnce(unlocked).mockImplementation(() => new Promise(() => {}));
  const gateway = { getEncryptedVaultStatus };
  const view: AssetView = { kind: "private_vault" };
  const { rerender } = render(<Harness gateway={gateway} view={view} onLeave={onLeave} />);
  await waitFor(() => expect(screen.getByText("unlocked")).toBeInTheDocument());
  workload.hidden = true;
  rerender(<Harness gateway={gateway} view={view} onLeave={onLeave} />);
  expect(screen.getByText("locked")).toBeInTheDocument();
  expect(onLeave).toHaveBeenCalledWith("locked");
  workload.hidden = false;
  rerender(<Harness gateway={gateway} view={view} onLeave={onLeave} />);
  expect(screen.queryByText("unlocked")).not.toBeInTheDocument();
});

it("keeps the same status object while reads return equal values, and replaces it when a field changes", async () => {
  vi.useFakeTimers();
  const events = mountEvents();
  const getEncryptedVaultStatus = vi.fn()
    .mockResolvedValueOnce({ ...unlocked })
    .mockResolvedValueOnce({ ...unlocked })
    .mockResolvedValueOnce({ ...unlocked, itemCount: 4 });
  const options = { gateway: { getEncryptedVaultStatus }, view: library, onLeave: vi.fn(), subscribeMountChanges: events.subscribe };
  const { result } = renderHook(() => useExternalVaultAvailability(options));
  await act(async () => { await vi.advanceTimersByTimeAsync(0); });
  const first = result.current.status;
  expect(first).toMatchObject(unlocked);

  await act(async () => { events.fire(); await vi.advanceTimersByTimeAsync(0); });
  expect(getEncryptedVaultStatus).toHaveBeenCalledTimes(2);
  expect(result.current.status).toBe(first);

  await act(async () => { events.fire(); await vi.advanceTimersByTimeAsync(0); });
  expect(result.current.status).toEqual({ ...unlocked, itemCount: 4 });
});
