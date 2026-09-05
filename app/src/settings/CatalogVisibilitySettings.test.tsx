import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { LibraryProvider } from "../library/LibraryContext";
import { libraryGateway } from "../library/client";
import { CatalogVisibilitySettings } from "./CatalogVisibilitySettings";

afterEach(cleanup);

function renderSettings() {
  let policy = {
    hiddenCategories: [2],
    blockedTags: [{ namespace: "artist", value: "sample" }],
  };
  const gateway = {
    ...libraryGateway,
    getCatalogVisibilityPolicy: vi.fn().mockImplementation(async () => policy),
    setCatalogCategoryHidden: vi.fn().mockImplementation(async (category: number, hidden: boolean) => {
      policy = {
        ...policy,
        hiddenCategories: hidden
          ? [...new Set([...policy.hiddenCategories, category])].sort((a, b) => a - b)
          : policy.hiddenCategories.filter((value) => value !== category),
      };
      return policy;
    }),
    setCatalogTagBlocked: vi.fn().mockImplementation(async (tag, blocked: boolean) => {
      policy = {
        ...policy,
        blockedTags: blocked
          ? [...policy.blockedTags, tag]
          : policy.blockedTags.filter((value) => value.namespace !== tag.namespace || value.value !== tag.value),
      };
      return policy;
    }),
  };
  const view = render(
    <LibraryProvider gateway={gateway}>
      <CatalogVisibilitySettings />
    </LibraryProvider>,
  );
  return { gateway, view };
}

it("loads and changes persistent category visibility", async () => {
  const { gateway } = renderSettings();
  const manga = await screen.findByRole("checkbox", { name: "만화 숨기기" });
  expect(manga).toBeChecked();
  const doujinshi = screen.getByRole("checkbox", { name: "동인지 숨기기" });
  expect(doujinshi).not.toBeChecked();

  await userEvent.click(doujinshi);

  expect(gateway.setCatalogCategoryHidden).toHaveBeenCalledWith(1, true);
  await waitFor(() => expect(doujinshi).toBeChecked());
});

it("adds and removes exact namespace and value tag pairs", async () => {
  const { gateway } = renderSettings();
  expect(await screen.findByText("artist:sample")).toBeVisible();

  await userEvent.type(screen.getByLabelText("차단 태그 네임스페이스"), "group");
  await userEvent.type(screen.getByLabelText("차단 태그 값"), "circle");
  await userEvent.click(screen.getByRole("button", { name: "태그 차단" }));

  expect(gateway.setCatalogTagBlocked).toHaveBeenCalledWith(
    { namespace: "group", value: "circle" },
    true,
  );
  expect(await screen.findByText("group:circle")).toBeVisible();

  await userEvent.click(screen.getByRole("button", { name: "artist:sample 차단 해제" }));
  expect(gateway.setCatalogTagBlocked).toHaveBeenCalledWith(
    { namespace: "artist", value: "sample" },
    false,
  );
  await waitFor(() => expect(screen.queryByText("artist:sample")).not.toBeInTheDocument());
});

it("reloads the saved policy when the settings surface is reopened", async () => {
  const { gateway, view } = renderSettings();
  expect(await screen.findByRole("checkbox", { name: "만화 숨기기" })).toBeChecked();
  view.unmount();
  render(
    <LibraryProvider gateway={gateway}>
      <CatalogVisibilitySettings />
    </LibraryProvider>,
  );

  expect(await screen.findByRole("checkbox", { name: "만화 숨기기" })).toBeChecked();
  expect(gateway.getCatalogVisibilityPolicy).toHaveBeenCalledTimes(2);
});

it("can retry after the initial policy load fails", async () => {
  const { gateway } = renderSettings();
  vi.mocked(gateway.getCatalogVisibilityPolicy)
    .mockReset()
    .mockRejectedValueOnce(new Error("temporary read failure"))
    .mockResolvedValueOnce({ hiddenCategories: [2], blockedTags: [] });

  cleanup();
  render(
    <LibraryProvider gateway={gateway}>
      <CatalogVisibilitySettings />
    </LibraryProvider>,
  );

  await userEvent.click(await screen.findByRole("button", { name: "다시 시도" }));

  expect(await screen.findByRole("checkbox", { name: "만화 숨기기" })).toBeChecked();
  expect(gateway.getCatalogVisibilityPolicy).toHaveBeenCalledTimes(2);
});
