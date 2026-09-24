import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { AssetView, EncryptedVaultStatus, LibraryGateway } from "../library/types";
import { useExternalVaultAvailability, VAULT_STATUS_POLL_MS, type VaultLeaveReason } from "./useExternalVaultAvailability";

const workload = vi.hoisted(() => ({ hidden: false, restricted: false }));
vi.mock("../app/workloadProfile", () => ({ useWorkloadProfile: () => workload }));
afterEach(() => { cleanup(); vi.useRealTimers(); workload.hidden = false; workload.restricted = false; });

const unlocked: EncryptedVaultStatus = { state: "unlocked", vaultId: "vault-1", root: "/vault", itemCount: 3, remembered: true };
const locked: EncryptedVaultStatus = { ...unlocked, state: "locked", itemCount: null };
const absent: EncryptedVaultStatus = { state: "absent", vaultId: null, root: null, itemCount: null, remembered: false };

function Harness({ gateway, view, onLeave }: {
  gateway: Pick<LibraryGateway, "getEncryptedVaultStatus">;
  view: AssetView;
  onLeave: (reason: VaultLeaveReason) => void;
}) {
  const { status } = useExternalVaultAvailability({ gateway, view, onLeave });
  return <span>{status?.state ?? "loading"}</span>;
}

it("loads status at startup and refreshes it on focus", async () => {
  const getEncryptedVaultStatus = vi.fn().mockResolvedValueOnce(unlocked).mockResolvedValueOnce(absent);
  render(<Harness gateway={{ getEncryptedVaultStatus }} view={{ kind: "classification", classificationId: null }} onLeave={vi.fn()} />);

  await waitFor(() => expect(screen.getByText("unlocked")).toBeInTheDocument());
  expect(getEncryptedVaultStatus).toHaveBeenCalledTimes(1);

  act(() => window.dispatchEvent(new Event("focus")));
  await waitFor(() => expect(screen.getByText("absent")).toBeInTheDocument());
  expect(getEncryptedVaultStatus).toHaveBeenCalledTimes(2);
});

it("polls while the window is visible so an inserted USB appears", async () => {
  vi.useFakeTimers();
  const getEncryptedVaultStatus = vi.fn().mockResolvedValueOnce(absent).mockResolvedValue(locked);
  render(<Harness gateway={{ getEncryptedVaultStatus }} view={{ kind: "classification", classificationId: null }} onLeave={vi.fn()} />);
  await act(async () => { await vi.advanceTimersByTimeAsync(0); });
  expect(screen.getByText("absent")).toBeInTheDocument();

  await act(async () => { await vi.advanceTimersByTimeAsync(VAULT_STATUS_POLL_MS); });
  expect(screen.getByText("locked")).toBeInTheDocument();

  Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
  try {
    const calls = getEncryptedVaultStatus.mock.calls.length;
    await act(async () => { await vi.advanceTimersByTimeAsync(VAULT_STATUS_POLL_MS * 3); });
    expect(getEncryptedVaultStatus).toHaveBeenCalledTimes(calls);
  } finally {
    Reflect.deleteProperty(document, "visibilityState");
  }
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
