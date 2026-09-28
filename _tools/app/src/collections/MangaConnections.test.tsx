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
