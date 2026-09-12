import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { PrivacyProvider } from "../privacy/PrivacyContext";
import { AvCollectionDetail } from "./AvCollectionDetail";
import type { AvGateway } from "./avTypes";
import type { CollectionSummary } from "../library/types";
afterEach(cleanup);
const collection: CollectionSummary = { id: "av", name: "작품", description: null, type: "av", coverAssetId: null, selectedWorkArtworkId: "cover", selectedHeroArtworkId: null, selectedBackdropArtworkId: null, assetCount: 0, unreadReleaseCount: 0, year: null, originalTitle: null, runtimeMinutes: null, author: null, developer: null, publisher: null, platforms: null, productionCompany: "제작사", releaseDate: null, director: null, externalScore: null, myScore: null, genres: null, overview: null, showcase: false, showcaseOrder: null, createdAt: "2026", updatedAt: "2026" };
it("loads local AV metadata and cover selections while privacy removes media", async () => {
  const api = { getDetails: vi.fn().mockResolvedValue({ collectionId: "av", revision: 0, productCode: "CODE", label: null, series: null, people: [{ id: "person", displayName: "이름", creditName: "표기", role: "performer", order: 0 }] }), getCoverSet: vi.fn().mockResolvedValue({ frontId: "cover", spineId: null, backId: null, revision: "r" }) } as unknown as AvGateway;
  const { container } = render(<PrivacyProvider privacyMode setPrivacyMode={vi.fn()}><AvCollectionDetail collection={collection} scope="fixture" api={api} onChanged={vi.fn()} onEdit={vi.fn()} onToggleShowcase={vi.fn()} onDelete={vi.fn()} /></PrivacyProvider>);
  expect(await screen.findByText("표기")).toBeInTheDocument();
  expect(api.getDetails).toHaveBeenCalledExactlyOnceWith("av"); expect(api.getCoverSet).toHaveBeenCalledExactlyOnceWith("av");
  expect(container.querySelector("img, canvas")).toBeNull(); expect(screen.getByRole("button", { name: "표지 감상" })).toBeDisabled();
  expect(screen.getByText(/모바일 컬렉션 공개 목록에 포함하지 않습니다/)).toBeInTheDocument();
});
