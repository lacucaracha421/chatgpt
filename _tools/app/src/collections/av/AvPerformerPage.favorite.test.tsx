import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { PrivacyProvider } from "../../privacy/PrivacyContext";
import type { AvGateway } from "../avTypes";
import { AvPerformerPage } from "./AvPerformerPage";

const favoritesApi = vi.hoisted(() => ({ list: vi.fn(), set: vi.fn() }));
vi.mock("../../library/client", () => ({
  libraryGateway: {
    listAvFavorites: favoritesApi.list,
    setAvFavorite: favoritesApi.set,
  },
}));
vi.mock("./AvPerformerProfile", () => ({ AvPerformerProfile: () => null, safeProfileUrl: () => false }));

beforeEach(() => {
  favoritesApi.list.mockResolvedValue([{ id: "p" }]);
  favoritesApi.set.mockResolvedValue(undefined);
});
afterEach(() => {
  cleanup();
  favoritesApi.list.mockReset();
  favoritesApi.set.mockReset();
});

it("loads and toggles the performer favorite from the existing header actions", async () => {
  const api = {
    getPerformer: vi.fn().mockResolvedValue({
      person: { id: "p", displayName: "배우", nameJa: null, wikidataId: null, fanzaActressId: null, memo: null, portrait: null },
      stats: { workCount: 0, firstRelease: null, lastRelease: null, averageScore: null },
      works: [], coPerformers: [], labels: [],
    }),
  } as unknown as AvGateway;
  render(<PrivacyProvider privacyMode={false} setPrivacyMode={vi.fn()}><AvPerformerPage personId="p" api={api} onBack={vi.fn()} /></PrivacyProvider>);

  const favorite = await screen.findByRole("button", { name: "즐겨찾기 해제" });
  expect(favorite).toHaveAttribute("aria-pressed", "true");
  expect(favorite.querySelector("svg")).toHaveAttribute("fill", "currentColor");

  fireEvent.click(favorite);
  await waitFor(() => expect(favoritesApi.set).toHaveBeenCalledWith("p", false));
  expect(await screen.findByRole("button", { name: "즐겨찾기" })).toHaveAttribute("aria-pressed", "false");
});
