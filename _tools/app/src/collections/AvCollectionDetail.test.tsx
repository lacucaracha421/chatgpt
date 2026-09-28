import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { PrivacyProvider } from "../privacy/PrivacyContext";
import { AvCollectionDetail } from "./AvCollectionDetail";
import type { AvGateway } from "./avTypes";
import type { CollectionSummary } from "../library/types";
afterEach(cleanup);
const collection: CollectionSummary = { id: "av", name: "작품", description: null, type: "av", coverAssetId: null, selectedWorkArtworkId: "cover", selectedHeroArtworkId: null, selectedBackdropArtworkId: null, assetCount: 0, unreadReleaseCount: 0, year: null, originalTitle: null, runtimeMinutes: null, author: null, developer: null, publisher: null, platforms: null, productionCompany: "제작사", releaseDate: null, director: null, externalScore: null, myScore: null, genres: null, overview: null, showcase: false, showcaseOrder: null, createdAt: "2026", updatedAt: "2026" };
it("loads local AV metadata and cover selections while privacy removes media", async () => {
  const api = { getDetails: vi.fn().mockResolvedValue({ collectionId: "av", revision: 0, productCode: "CODE", label: null, series: null, titleJa: null, releaseDate: null, maker: null, genres: [], makerCount: 0, labelCount: 0, seriesCount: 0, people: [{ id: "person", displayName: "이름", creditName: "표기", nameJa: null, workCount: 1, portrait: null, role: "performer", order: 0 }] }), getCoverSet: vi.fn().mockResolvedValue({ frontId: "cover", spineId: null, backId: null, revision: "r" }), getRelated: vi.fn().mockResolvedValue(null) } as unknown as AvGateway;
  const { container } = render(<PrivacyProvider privacyMode setPrivacyMode={vi.fn()}><AvCollectionDetail collection={collection} scope="fixture" api={api} onChanged={vi.fn()} onEdit={vi.fn()} onToggleShowcase={vi.fn()} onDelete={vi.fn()} /></PrivacyProvider>);
  expect(await screen.findByText("표기")).toBeInTheDocument();
  expect(api.getDetails).toHaveBeenCalledExactlyOnceWith("av"); expect(api.getCoverSet).toHaveBeenCalledExactlyOnceWith("av");
  expect(container.querySelector("img, canvas")).toBeNull(); expect(screen.getByRole("button", { name: "표지 감상" })).toBeDisabled();
  expect(screen.getByText(/모바일 컬렉션 공개 목록에 포함하지 않습니다/)).toBeInTheDocument();
});

it("renders the 1A identity and non-empty shelves, then opens a performer page", async () => {
  const detail = { collectionId: "av", revision: 1, productCode: "CODE-1", label: "LABEL", series: "SERIES", titleJa: "日本語タイトル", releaseDate: "2024-01-02", maker: "MAKER", genres: ["ドラマ"], makerCount: 3, labelCount: 2, seriesCount: 4, people: [{ id: "person", displayName: "배우", creditName: "표기", nameJa: "俳優", workCount: 2, portrait: null, role: "performer" as const, order: 0 }] };
  const related = { performers: [{ personId: "person", displayName: "배우", total: 2, items: [{ collectionId: "other", name: "다른 작품", productCode: "CODE-2", releaseDate: "2023-01-01", frontArtworkId: null, spineArtworkId: null, backArtworkId: null, coverRevision: "r2" }] }], series: null, label: null };
  const performer = { person: { id: "person", displayName: "배우", nameJa: "俳優", wikidataId: "Q1", fanzaActressId: "F1", memo: null, portrait: null }, stats: { workCount: 2, firstRelease: "2023-01-01", lastRelease: "2024-01-02", averageScore: 4 }, works: [], coPerformers: [], labels: [] };
  const api = {
    getDetails: vi.fn().mockResolvedValue(detail), getCoverSet: vi.fn().mockResolvedValue({ frontId: "front", spineId: "spine", backId: "back", revision: "r1" }),
    getRelated: vi.fn().mockResolvedValue(related), getStashdbCredentialStatus: vi.fn().mockResolvedValue({ configured: false }), getPerformerProfile: vi.fn().mockResolvedValue(null), getPerformer: vi.fn().mockResolvedValue(performer),
  } as unknown as AvGateway;
  const ratedCollection = { ...collection, description: "개인 메모", myScore: 4, runtimeMinutes: 120, releaseDate: "2024-01-02" };
  render(<PrivacyProvider privacyMode={false} setPrivacyMode={vi.fn()}><AvCollectionDetail collection={ratedCollection} scope="fixture" api={api} onChanged={vi.fn().mockResolvedValue(undefined)} onEdit={vi.fn()} onToggleShowcase={vi.fn()} onDelete={vi.fn()} /></PrivacyProvider>);

  expect(await screen.findByRole("heading", { level: 1, name: "日本語タイトル" })).toBeInTheDocument();
  expect(screen.getAllByLabelText("내 별점 4/5")).toHaveLength(2);
  expect(screen.getByText("개인 메모")).toBeInTheDocument();
  expect(screen.getByRole("heading", { level: 2, name: "같은 배우의 다른 작품" })).toBeInTheDocument();
  expect(screen.queryByText("같은 시리즈")).not.toBeInTheDocument();
  expect(screen.queryByText("같은 레이블")).not.toBeInTheDocument();

  fireEvent.click(screen.getByRole("button", { name: /배우.*내 라이브러리 2편/ }));
  await waitFor(() => expect(api.getPerformer).toHaveBeenCalledWith("person"));
  expect(await screen.findByRole("article", { name: "AV 배우 상세" })).toBeInTheDocument();
});
