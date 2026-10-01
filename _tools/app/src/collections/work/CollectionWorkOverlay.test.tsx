// These fixtures exercise only the frontend command contracts, never a library on disk.
vi.mock("../physical/collectibleRuntime", async importOriginal => ({ ...await importOriginal<typeof import("../physical/collectibleRuntime")>(), acquireCover: (_request: unknown, callback: (value: null) => void) => { callback(null); return () => undefined; } }));
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LibraryProvider } from "../../library/LibraryContext";
import { PrivacyProvider } from "../../privacy/PrivacyContext";
import type { CollectionSummary, LibraryGateway } from "../../library/types";
import type { AvGateway } from "../avTypes";
import { BackNavigationProvider } from "../../shared/navigation/BackNavigation";
import { CollectionBrowser } from "../CollectionBrowser";
import { createDefaultCollectionLibraryState, type CollectionLibraryState } from "../collectionLibrary";
import { CollectionWorkOverlay } from "./CollectionWorkOverlay";

afterEach(cleanup);
const base: CollectionSummary = { id: "a", name: "가 작품", type: "game", description: "기록", coverAssetId: null, selectedWorkArtworkId: null, selectedHeroArtworkId: null, selectedBackdropArtworkId: null, assetCount: 0, unreadReleaseCount: 0, year: 2026, originalTitle: null, runtimeMinutes: null, author: null, developer: "개발", publisher: "배급", platforms: "Switch 2", productionCompany: null, releaseDate: "2026-09-01", director: null, externalScore: null, myScore: 3, genres: null, overview: null, showcase: false, showcaseOrder: null, createdAt: "2026-09-02T00:00:00Z", updatedAt: "r" };
function fixtures(type: "game" | "av" | "movie" = "game") {
  const items = [{ ...base, type }, { ...base, id: "b", name: "나 작품", type }];
  const records: Record<string, {status:string|null;ownedPlatform:string|null;myScore:number|null;memo:string|null}> = {};
  const gateway = { getCollectionWorkRecord: vi.fn().mockImplementation(async (id: string) => records[id] ?? {status:null,ownedPlatform:null,myScore:3,memo:"기록"}), saveCollectionWorkRecord: vi.fn().mockImplementation(async (id: string, edit: {field:string;value:string|number|null}) => records[id] = {...(records[id] ?? {status:null,ownedPlatform:null,myScore:3,memo:"기록"}),[edit.field]:edit.value}), listCollectionWorkArtworks: vi.fn().mockResolvedValue([]), importCollectionArtworks: vi.fn().mockResolvedValue(0), getTmdbConnection: vi.fn().mockResolvedValue(null), getIgdbConnection: vi.fn().mockResolvedValue({ gameId: 1 }), updateCollection: vi.fn().mockResolvedValue(undefined), setCollectionShowcase: vi.fn().mockResolvedValue(undefined), deleteCollection: vi.fn().mockResolvedValue(undefined), refreshIgdbGame: vi.fn().mockResolvedValue(undefined) };
  const api = { getDetails: vi.fn().mockImplementation(async (id: string) => ({ collectionId: id, revision: 1, productCode: "ABC-123", titleJa: null, maker: "메이커", label: "레이블", series: null, releaseDate: "2026-09-01", genres: [], people: [{ id: "person", displayName: "배우", role: "performer", order: 0, creditName: null, nameJa: null, workCount: 1, portrait: null }], makerCount: 1, labelCount: 1, seriesCount: 0 })), getCoverSet: vi.fn().mockResolvedValue({ frontId: null, spineId: null, backId: null, revision: "r" }), getRelated: vi.fn().mockResolvedValue({ performers: [], series: null, label: null }), searchPeople: vi.fn().mockResolvedValue([]), getPerformer: vi.fn().mockResolvedValue({ person: { id: "person", displayName: "배우", nameJa: null, memo: null, portrait: null }, stats: { workCount: 1, firstRelease: null, lastRelease: null, averageScore: null }, works: [], coPerformers: [], labels: [] }), getPerformerProfile: vi.fn().mockResolvedValue(null), getStashdbCredentialStatus: vi.fn().mockResolvedValue({ configured: false }) };
  const exit = vi.fn(); const changed = vi.fn().mockResolvedValue(undefined);
  function Harness() {
    const [id, setId] = useState<string | null>(null);
    const [order, setOrder] = useState<string[]>([]);
    const [state, setState] = useState<CollectionLibraryState>({ ...createDefaultCollectionLibraryState()[type], sort: "name", direction: "asc" });
    return <BackNavigationProvider><LibraryProvider gateway={gateway as unknown as LibraryGateway}><PrivacyProvider privacyMode={false} setPrivacyMode={vi.fn()}>
      {id ? <CollectionWorkOverlay collection={items.find(item => item.id === id)!} collections={items} listOrder={order} api={api as unknown as AvGateway} onOpenCollection={setId} onExit={() => { exit(); setId(null); }} onChanged={changed} onOpenSettings={vi.fn()} /> : <CollectionBrowser collections={items} typeFilter={type} showcase={false} libraryState={state} onLibraryStateChange={setState} onChanged={changed} onViewChange={view => { if (view.kind === "collection") setId(view.collectionId); }} onOpenWork={(nextId, nextOrder) => { setOrder(nextOrder); setId(nextId); }} />}
    </PrivacyProvider></LibraryProvider></BackNavigationProvider>;
  }
  return { gateway, api, exit, changed, Harness };
}
describe("Collection work open path", () => {
  it.each(["game", "av", "movie"] as const)("opens %s by double-click / Enter with the actual list position, and Escape returns", async type => {
    const { Harness, exit } = fixtures(type); render(<Harness />); const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: /^가 작품/ })); expect(screen.queryByRole("article")).toBeNull();
    await user.dblClick(screen.getByRole("button", { name: /^가 작품/ }));
    const root = await screen.findByRole("article", { name: type === "game" ? "게임 작품 화면" : type === "movie" ? "영화 작품 화면" : "AV 작품 화면" });
    expect(root.querySelector(".asset-viewer__position")).toHaveTextContent("1 / 2");
    await user.keyboard("{Escape}"); expect(exit).toHaveBeenCalledOnce();
    const second = screen.getByRole("button", { name: /^나 작품/ }); second.focus(); await user.keyboard("{Enter}");
    expect((await screen.findByRole("article")).querySelector(".asset-viewer__position")).toHaveTextContent("2 / 2");
  });
  it.each(["game", "movie"] as const)("holds the old %s through a delayed command and steps without unmounting", async type => {
    const { Harness, gateway } = fixtures(type); let release!: (items: []) => void;
    gateway.listCollectionWorkArtworks.mockImplementation((id: string) => id === "b" ? new Promise(resolve => { release = resolve; }) : Promise.resolve([]));
    render(<Harness />); const user = userEvent.setup(); await user.dblClick(screen.getByRole("button", { name: /^가 작품/ }));
    const root = await screen.findByRole("article");
    await user.click(screen.getByRole("button", { name: "다음 작품" }));
    expect(screen.getByRole("heading", { name: /^가 작품/ })).toBeInTheDocument(); expect(root).toHaveAttribute("aria-busy", "true");
    await act(async () => release([]));
    await screen.findByRole("heading", { name: /^나 작품/ }); expect(screen.getByRole("article")).toBe(root);
  });
  it("saves each personal field through the PC command without a stale full-work write", async () => {
    const {Harness,gateway}=fixtures(); render(<Harness/>); const user=userEvent.setup();
    await user.dblClick(screen.getByRole("button",{name:/^가 작품/}));
    await user.click(await screen.findByRole("button",{name:"별점 5점"}));
    await waitFor(()=>expect(gateway.saveCollectionWorkRecord).toHaveBeenCalledWith("a",{field:"myScore",value:5}));
    const memo=screen.getByRole("textbox",{name:"메모"}); await user.clear(memo); await user.type(memo,"새 기록"); await user.tab();
    await waitFor(()=>expect(gateway.saveCollectionWorkRecord).toHaveBeenCalledWith("a",{field:"memo",value:"새 기록"}));
    expect(gateway.updateCollection).not.toHaveBeenCalled();
    expect(screen.queryByRole("button",{name:"저장"})).toBeNull();
  });
  it("keeps AV information editing, artwork selection, performers, Showcase and delete reachable", async () => {
    const { Harness, api, gateway } = fixtures("av"); render(<Harness />); const user = userEvent.setup(); await user.dblClick(screen.getByRole("button", { name: /^가 작품/ }));
    await user.click(await screen.findByRole("button", { name: "작품 관리" }));
    for (const label of ["컬렉션 편집", "AV 정보 편집", "표지 앞면·책등·뒷면", "쇼케이스에 추가", "컬렉션 삭제"]) expect(screen.getByRole("menuitem", { name: label })).toBeInTheDocument();
    await user.click(screen.getByRole("menuitem", { name: "AV 정보 편집" })); expect(screen.getByRole("dialog", { name: "AV 정보 편집" })).toBeInTheDocument(); await user.keyboard("{Escape}");
    await user.click(screen.getByRole("button", { name: "작품 관리" })); await user.click(screen.getByRole("menuitem", { name: "표지 앞면·책등·뒷면" })); expect(screen.getByRole("dialog", { name: "표지 앞면·책등·뒷면" })).toBeInTheDocument(); await user.keyboard("{Escape}");
    await user.click(screen.getByRole("button", { name: /배우.*내 라이브러리/ })); expect(await screen.findByRole("article", { name: "AV 배우 상세" })).toBeInTheDocument(); expect(api.getPerformer).toHaveBeenCalledWith("person"); await user.keyboard("{Escape}");
    await user.click(screen.getByRole("button", { name: "쇼케이스" })); await waitFor(() => expect(gateway.setCollectionShowcase).toHaveBeenCalledWith("a", true));
    await user.click(screen.getByRole("button", { name: "작품 관리" })); await user.click(screen.getByRole("menuitem", { name: "컬렉션 삭제" })); const dialog = screen.getByRole("dialog", { name: "컬렉션 삭제" });
    expect(gateway.deleteCollection).not.toHaveBeenCalled(); await user.click(within(dialog).getByRole("button", { name: "삭제" })); await waitFor(() => expect(gateway.deleteCollection).toHaveBeenCalledWith("a"));
  });
});
