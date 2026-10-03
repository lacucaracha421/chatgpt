import { cleanup, render } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { PrivacyProvider } from "../privacy/PrivacyContext";
import { OnlineCatalogCard } from "./OnlineCatalogCard";
import type { CatalogGroupedWork } from "../library/types";

afterEach(cleanup);
const work: CatalogGroupedWork = {
  provider: "kHentai", providerWorkId: "42", groupId: "group", title: "작품", titleJpn: null,
  artists: [], series: [], thumbnailUrl: "https://example.com/cover.jpg", bookmarked: false,
  fileCount: 40, views: 100, posted: 1000, versionCount: 1, hasBookmarkedVersion: false,
};

it("removes online catalog image sources when only the NSFW filter turns on", () => {
  const card = <OnlineCatalogCard work={work} opening={false} bookmarkPending={false} onOpen={vi.fn()} onBookmark={vi.fn()} />;
  const { container, rerender } = render(<PrivacyProvider privacyMode={false} setPrivacyMode={vi.fn()}>{card}</PrivacyProvider>);
  expect(container.querySelector("img[src]")).not.toBeNull();
  rerender(<PrivacyProvider privacyMode={false} nsfwFilter setPrivacyMode={vi.fn()}>{card}</PrivacyProvider>);
  expect(container.querySelector("img")).toBeNull();
  expect(container.querySelector("[src]")).toBeNull();
  expect(container.querySelector(".privacy-mask")).toBeVisible();
});
