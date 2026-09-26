import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { LibraryProvider } from "../library/LibraryContext";
import type { CollectionTrackingGateway, LibraryGateway, ReleaseInboxItem } from "../library/types";
import { useReleaseData, resetReleaseDataForTests } from "./releaseData";
import { CollectionOwnershipPanel } from "./CollectionOwnershipPanel";
import { CollectionReleases } from "./CollectionReleases";
import type { CollectionSummary, ReleaseBoardEntry } from "../library/types";

afterEach(() => { cleanup(); resetReleaseDataForTests(); });
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
const works = [{ id: "m", name: "작품", type: "manga", unreadReleaseCount: 1 }] as CollectionSummary[];
const watched: ReleaseBoardEntry = { collectionId: "m", releaseWatch: { enabled: true, available: true }, ownedVolumes: [{ editionIndex: 0, count: 6 }],
  releaseSchedule: { kakao: { editionIndex: 0, checkedAt: null, volumes: [{ volumeNumber: 7, date: "2026-10-01", status: null }] }, mangadex: null } };
/** The 신간 view fed by the shared release data, as the browser mounts it. */
function Releases({ api, provider = "kakao", onOpen = vi.fn(), onChanged = vi.fn() }: { api: CollectionTrackingGateway; provider?: "kakao" | "mangadex"; onOpen?: (id: string) => void; onChanged?: () => void }) {
  const data = useReleaseData(api, works, true);
  return <CollectionReleases provider={provider} collections={works} data={data.data} loading={data.loading} error={data.error} coverUrl={() => null} onOpen={onOpen} onChanged={onChanged} onProviderChange={vi.fn()} />;
}
it("does not acknowledge on open, and confirming a notification does not mark ownership", async () => {
  const api = tracking();
  api.releaseBoard = vi.fn().mockResolvedValue([watched]);
  render(wrap(api, <Releases api={api} />));
  await screen.findByText("작품");
  expect(api.acknowledge).not.toHaveBeenCalled();
  await userEvent.click(screen.getByRole("button", { name: "모두 확인" }));
  await userEvent.click(within(screen.getByRole("dialog", { name: "모두 확인할까요?" })).getByRole("button", { name: "모두 확인" }));
  await waitFor(() => expect(api.acknowledge).toHaveBeenCalledWith("m", ["e"]));
  expect(api.setOwnership).not.toHaveBeenCalled();
  expect(api.setOwnedCount).not.toHaveBeenCalled();
  // The release information stays; only the NEW marks go.
  await waitFor(() => expect(screen.queryByText("NEW")).not.toBeInTheDocument());
  expect(screen.getByText(/7권 ·/)).toBeInTheDocument();
});
it("keeps the notification when confirmation fails", async () => {
  const api = tracking();
  api.releaseBoard = vi.fn().mockResolvedValue([watched]);
  vi.mocked(api.acknowledge).mockRejectedValue(new Error("저장 실패"));
  render(wrap(api, <Releases api={api} />));
  await userEvent.click(await screen.findByRole("button", { name: "작품 확인" }));
  await screen.findByRole("alert");
  expect(api.setOwnedCount).not.toHaveBeenCalled();
  expect(screen.getByLabelText("새 알림 1개")).toBeInTheDocument();
});

it("opens a work from its title without acknowledging", async () => {
  const api = tracking();
  api.releaseBoard = vi.fn().mockResolvedValue([watched]);
  const open = vi.fn();
  render(wrap(api, <Releases api={api} onOpen={open} />));
  await userEvent.click(await screen.findByRole("button", { name: /^작품(?! 확인)/ }));
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
  render(wrap(api, <Releases api={api} provider="mangadex" onOpen={open} />));
  expect(await screen.findByRole("button", {name:"재시도 대기"})).toBeDisabled();
  expect(screen.getByText(/표지 목록 조회 · HTTP 503 · 서버 오류/)).toBeInTheDocument();
  expect(screen.getByText(/자동 재시도합니다/)).toBeInTheDocument();
  await userEvent.click(screen.getByRole("button", {name:"실패한 작품 보기"}));
  expect(open).toHaveBeenCalledWith("failed-work");
  expect(api.runUpdates).not.toHaveBeenCalled();
});
