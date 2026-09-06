import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { LibraryProvider } from "../library/LibraryContext";
import type { CollectionTrackingGateway, LibraryGateway, ReleaseInboxItem } from "../library/types";
import { CollectionOwnershipPanel } from "./CollectionOwnershipPanel";
import { ReleaseInbox } from "./ReleaseInbox";

afterEach(cleanup);
const item: ReleaseInboxItem = { collectionId: "m", collectionName: "작품", event: { id: "e", kind: "new_volume", volumeNumber: 7, previousValue: null, currentValue: "2026-10-01", detectedAt: "2026-09-06T00:00:00Z" } };
function tracking(): CollectionTrackingGateway {
  return { setOwnedCount: vi.fn().mockResolvedValue([]), listOwnership: vi.fn().mockResolvedValue([]), setOwnership: vi.fn().mockResolvedValue([]), listInbox: vi.fn().mockResolvedValue([item]), acknowledge: vi.fn().mockResolvedValue(undefined) };
}
function wrap(api: CollectionTrackingGateway, children: React.ReactNode) {
  return <LibraryProvider gateway={{ collectionTracking: api } as LibraryGateway}>{children}</LibraryProvider>;
}
it("uses one owned count and permits lowering it to zero", async () => {
  const api = tracking();
  vi.mocked(api.listOwnership).mockResolvedValue([{ volumeNumber: 1, editionIndex: 1, physical: true, digital: true }]);
  render(wrap(api, <CollectionOwnershipPanel collectionId="m" volumes={[]} editionIndex={1} />));
  await waitFor(() => expect(screen.getByLabelText("현재 보유 권수")).toHaveValue(1));
  expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();
  await userEvent.clear(screen.getByLabelText("현재 보유 권수"));
  await userEvent.type(screen.getByLabelText("현재 보유 권수"), "0");
  await userEvent.click(screen.getByRole("button", { name: "저장" }));
  expect(api.setOwnedCount).toHaveBeenCalledWith("m", 1, 0);
});
it("does not acknowledge inbox on open, and checking a notification does not mark ownership", async () => {
  const api = tracking();
  render(wrap(api, <ReleaseInbox onClose={vi.fn()} onChanged={vi.fn()} />));
  await screen.findByText("작품");
  expect(api.acknowledge).not.toHaveBeenCalled();
  await userEvent.click(screen.getByRole("button", { name: "확인" }));
  await waitFor(() => expect(api.acknowledge).toHaveBeenCalledWith("m", ["e"]));
  expect(api.setOwnership).not.toHaveBeenCalled();
  expect(await screen.findByText("확인하지 않은 신간 알림이 없습니다.")).toBeInTheDocument();
});
it("keeps the notification when confirmation fails", async () => {
  const api = tracking();
  vi.mocked(api.acknowledge).mockRejectedValue(new Error("저장 실패"));
  render(wrap(api, <ReleaseInbox onClose={vi.fn()} onChanged={vi.fn()} />));
  await userEvent.click(await screen.findByRole("button", { name: "확인" }));
  await screen.findByRole("alert");
  expect(api.setOwnedCount).not.toHaveBeenCalled();
  expect(screen.getByText("작품")).toBeInTheDocument();
});
