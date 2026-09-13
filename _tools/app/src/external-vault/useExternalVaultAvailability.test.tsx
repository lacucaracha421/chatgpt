import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { AssetView, LibraryGateway, PrivateVaultStatus } from "../library/types";
import { useExternalVaultAvailability } from "./useExternalVaultAvailability";

afterEach(cleanup);

const available: PrivateVaultStatus = {
  registered: true, available: true, vaultId: "vault-1", root: "/vault", assetCount: 3, readOnly: false,
};
const unavailable: PrivateVaultStatus = { ...available, available: false, root: null };

function Harness({ gateway, view, onDisconnect }: {
  gateway: Pick<LibraryGateway, "getPrivateVaultStatus">;
  view: AssetView;
  onDisconnect: () => void;
}) {
  const { status } = useExternalVaultAvailability({ gateway, view, onDisconnect });
  return <span>{status?.available ? "available" : status ? "unavailable" : "loading"}</span>;
}
it("loads status at startup and refreshes it when the window regains focus", async () => {
  const getPrivateVaultStatus = vi.fn().mockResolvedValueOnce(available).mockResolvedValueOnce(unavailable);
  render(<Harness gateway={{ getPrivateVaultStatus }} view={{ kind: "classification", classificationId: null }} onDisconnect={vi.fn()} />);

  await waitFor(() => expect(screen.getByText("available")).toBeInTheDocument());
  expect(getPrivateVaultStatus).toHaveBeenCalledTimes(1);

  act(() => window.dispatchEvent(new Event("focus")));
  await waitFor(() => expect(screen.getByText("unavailable")).toBeInTheDocument());
  expect(getPrivateVaultStatus).toHaveBeenCalledTimes(2);
});

it("requests navigation away when an open secret view becomes unavailable", async () => {
  const onDisconnect = vi.fn();
  const getPrivateVaultStatus = vi.fn().mockResolvedValueOnce(available).mockResolvedValueOnce(unavailable);
  render(<Harness gateway={{ getPrivateVaultStatus }} view={{ kind: "private_vault" }} onDisconnect={onDisconnect} />);

  await waitFor(() => expect(screen.getByText("available")).toBeInTheDocument());
  act(() => window.dispatchEvent(new Event("focus")));
  await waitFor(() => expect(onDisconnect).toHaveBeenCalledTimes(1));
});
