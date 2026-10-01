import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { MangaConnections } from "./MangaConnections";

afterEach(cleanup);

it("folds the connection prompt when the Kakao prompt is hidden", async () => {
  const user = userEvent.setup();
  render(
    <MangaConnections
      mangaDex={null}
      kakao={null}
      mangaDexBusy={false}
      kakaoBusy={false}
      onConnectMangaDex={vi.fn()}
      onRefreshMangaDex={vi.fn()}
      onConnectKakao={vi.fn()}
      onRefreshKakao={vi.fn()}
      hideConnectionPrompt
    />,
  );

  expect(screen.queryByText("작품 연결")).not.toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: /연결/ }));
  expect(screen.getByRole("button", { name: "카카오 연결" })).toBeInTheDocument();
});

it("shows the last sync time and preserves the not-yet-synced label", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(2026, 9, 1, 16));
  try {
    render(<MangaConnections mangaDex={{ lastSyncedAt: "2026-09-30T15:07:40" } as React.ComponentProps<typeof MangaConnections>["mangaDex"]}
      kakao={{ provider: "kakao", lastSyncedAt: null } as React.ComponentProps<typeof MangaConnections>["kakao"]}
      mangaDexBusy={false} kakaoBusy={false} onConnectMangaDex={vi.fn()} onRefreshMangaDex={vi.fn()} onConnectKakao={vi.fn()} onRefreshKakao={vi.fn()} />);
    await userEvent.click(screen.getByRole("button", { name: /연결/ }));
    expect(screen.getByText("마지막 갱신 어제 15:07")).toBeInTheDocument();
    expect(screen.getByText("아직 갱신 전")).toBeInTheDocument();
  } finally { vi.useRealTimers(); }
});
