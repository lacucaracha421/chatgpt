import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { CharacterTaggerTags, type CharacterTagLinks } from "./CharacterTaggerTags";

afterEach(cleanup);

function fixture(pendingRecommendations: number) {
  let links: CharacterTagLinks = { linked: [{ tag: "alice", pendingRecommendations }], excluded: ["old_tag"] };
  return {
    list: vi.fn(async () => links),
    unlink: vi.fn(async () => { links = { linked: [], excluded: ["alice", "old_tag"] }; }),
    relink: vi.fn(async () => { links = { linked: [{ tag: "old_tag", pendingRecommendations: 0 }], excluded: [] }; }),
  };
}

it("confirms the number of recommendations, cancels safely, and persists an unlink", async () => {
  const api = fixture(98), user = userEvent.setup();
  render(<CharacterTaggerTags targetId="target" api={api} />);
  await user.click(await screen.findByRole("button", { name: "alice 연결 끊기" }));
  let dialog = screen.getByRole("dialog");
  expect(within(dialog).getByText("추천 98장이 사라집니다.")).toBeTruthy();
  expect(api.unlink).not.toHaveBeenCalled();
  await user.click(within(dialog).getByRole("button", { name: "취소" }));
  expect(api.unlink).not.toHaveBeenCalled();
  await user.click(screen.getByRole("button", { name: "alice 연결 끊기" }));
  dialog = screen.getByRole("dialog");
  await user.click(within(dialog).getByRole("button", { name: "연결 끊기" }));
  await waitFor(() => expect(api.unlink).toHaveBeenCalledWith("target", "alice", 98));
  await screen.findByText("연결된 태거 태그가 없습니다.");
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(screen.getByText(/연결을 끊은 태그/).closest("details")?.open).toBe(false);
});

it("unlinks without confirmation when no recommendations disappear and can relink", async () => {
  const api = fixture(0), user = userEvent.setup();
  render(<CharacterTaggerTags targetId="target" api={api} />);
  await user.click(await screen.findByRole("button", { name: "alice 연결 끊기" }));
  await waitFor(() => expect(api.unlink).toHaveBeenCalledWith("target", "alice", 0));
  expect(screen.queryByRole("dialog")).toBeNull();
  await user.click(await screen.findByText(/연결을 끊은 태그/));
  await user.click(screen.getByRole("button", { name: "old_tag 다시 연결" }));
  await waitFor(() => expect(api.relink).toHaveBeenCalledWith("target", "old_tag"));
  await screen.findByRole("button", { name: "old_tag 연결 끊기" });
});

it("refreshes the confirmation count after a stale unlink fails", async () => {
  const api = fixture(0), user = userEvent.setup();
  api.unlink.mockRejectedValueOnce({ code: "character_stale", message: "추천이 바뀌었습니다." });
  api.list.mockResolvedValueOnce({ linked: [{ tag: "alice", pendingRecommendations: 0 }], excluded: [] });
  api.list.mockResolvedValueOnce({ linked: [{ tag: "alice", pendingRecommendations: 2 }], excluded: [] });
  render(<CharacterTaggerTags targetId="target" api={api} />);
  await user.click(await screen.findByRole("button", { name: "alice 연결 끊기" }));
  await screen.findByRole("alert");
  await waitFor(() => expect(screen.getByRole("button", { name: "alice 연결 끊기" }).hasAttribute("disabled")).toBe(false));
  await user.click(screen.getByRole("button", { name: "alice 연결 끊기" }));
  expect(await screen.findByText("추천 2장이 사라집니다.")).toBeTruthy();
  expect(api.unlink).toHaveBeenCalledTimes(1);
});
