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
  let inbox = [item];
  return { setOwnedCount: vi.fn().mockResolvedValue([]), listOwnership: vi.fn().mockResolvedValue([]), setOwnership: vi.fn().mockResolvedValue([]), listInbox: vi.fn().mockImplementation(async () => inbox), acknowledge: vi.fn().mockImplementation(async (_id, ids) => { inbox = inbox.filter(entry => !ids.includes(entry.event.id)); }) };
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
  render(wrap(api, <ReleaseInbox provider="kakao" onOpen={vi.fn()} onChanged={vi.fn()} />));
  await screen.findByText("작품");
  expect(api.acknowledge).not.toHaveBeenCalled();
  await userEvent.click(screen.getByRole("button", { name: "모두 확인" }));
  await waitFor(() => expect(api.acknowledge).toHaveBeenCalledWith("m", ["e"]));
  expect(api.setOwnership).not.toHaveBeenCalled();
  expect(await screen.findByText("확인하지 않은 신간 알림이 없습니다.")).toBeInTheDocument();
});
it("keeps the notification when confirmation fails", async () => {
  const api = tracking();
  vi.mocked(api.acknowledge).mockRejectedValue(new Error("저장 실패"));
  render(wrap(api, <ReleaseInbox provider="kakao" onOpen={vi.fn()} onChanged={vi.fn()} />));
  await userEvent.click(await screen.findByRole("button", { name: "모두 확인" }));
  await screen.findByRole("alert");
  expect(api.setOwnedCount).not.toHaveBeenCalled();
  expect(screen.getByText("작품")).toBeInTheDocument();
});

it("separates providers, groups a work once and navigates without acknowledging", async () => {
  const api = tracking();
  vi.mocked(api.listInbox).mockResolvedValue([
    { ...item, provider: "kakao" },
    { ...item, provider: "mangadex", collectionName: "MangaDex 작품" },
    { ...item, provider: "mangadex", collectionName: "MangaDex 작품", event: { ...item.event, id: "e2" } },
  ]);
  const open = vi.fn();
  render(wrap(api, <ReleaseInbox provider="mangadex" onOpen={open} onChanged={vi.fn()} />));
  const title = await screen.findByRole("button", { name: "MangaDex 작품" });
  expect(screen.queryByRole("img")).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: /^작품$/ })).not.toBeInTheDocument();
  expect(screen.getAllByRole("button", { name: "MangaDex 작품" })).toHaveLength(1);
  await userEvent.click(title);
  expect(open).toHaveBeenCalledWith("m");
  expect(api.acknowledge).not.toHaveBeenCalled();
});
it("keeps an unentered count blank and lets the user explicitly save zero", async () => {
  const api = tracking();
  api.ownershipTracking = vi.fn().mockResolvedValue([]);
  render(wrap(api, <CollectionOwnershipPanel collectionId="m" volumes={[]} editionIndex={0} />));
  await waitFor(() => expect(screen.getByLabelText("현재 보유 권수")).toBeEnabled());
  expect(screen.getByLabelText("현재 보유 권수")).toHaveValue(null);
  await userEvent.type(screen.getByLabelText("현재 보유 권수"), "0");
  await userEvent.click(screen.getByRole("button", { name: "저장" }));
  expect(api.setOwnedCount).toHaveBeenCalledWith("m", 0, 0);
});

it("explains the failed request, respects cooldown and opens the affected work", async () => {
  const api = tracking();
  api.runUpdates = vi.fn();
  api.updateStatus = vi.fn().mockResolvedValue({
    provider:"mangadex", checked:103, changedCollections:0, failed:1, remaining:31,
    requests:208, elapsedMs:60000, networkMs:40000, throttleMs:8000,
    startedAt:null, finishedAt:null, retryAt:new Date(Date.now()+60000).toISOString(),
    stopReason:"unavailable", busy:false, consecutiveFailures:1,
    lastFailure:{collectionId:"failed-work",detectedAt:new Date().toISOString(),kind:"http",endpoint:"covers",httpStatus:503,retryAfterSeconds:60},
  });
  const open = vi.fn();
  render(wrap(api, <ReleaseInbox provider="mangadex" onOpen={open} onChanged={vi.fn()}/>));
  expect(await screen.findByRole("button", {name:"재시도 대기"})).toBeDisabled();
  expect(screen.getByText(/표지 목록 조회 · HTTP 503 · 서버 오류/)).toBeInTheDocument();
  expect(screen.getByText(/자동 재시도합니다/)).toBeInTheDocument();
  await userEvent.click(screen.getByRole("button", {name:"실패한 작품 보기"}));
  expect(open).toHaveBeenCalledWith("failed-work");
  expect(api.runUpdates).not.toHaveBeenCalled();
});
