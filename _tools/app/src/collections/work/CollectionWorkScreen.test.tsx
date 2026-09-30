import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CollectionWorkScreen, type CollectionWorkData, type WorkActions } from "./CollectionWorkScreen";
import type { CollectionSummary } from "../../library/types";
import { PrivacyProvider } from "../../privacy/PrivacyContext";

afterEach(cleanup);
const fixtureWork: CollectionSummary = {
  id: "game-1", name: "게임 하나", type: "game", description: "기존 메모", coverAssetId: null, selectedWorkArtworkId: "front", selectedHeroArtworkId: null, selectedBackdropArtworkId: null,
  assetCount: 0, unreadReleaseCount: 0, year: 2026, originalTitle: null, runtimeMinutes: null, author: null, developer: "개발사", publisher: "배급사", platforms: "Switch 2", productionCompany: null, releaseDate: "2026-09-01", director: null, externalScore: 80, myScore: 3.5, genres: "RPG", overview: "개요는 표시하지 않음", showcase: false, showcaseOrder: null, createdAt: "2026-09-02T00:00:00Z", updatedAt: "r1",
};
function value(av = false): CollectionWorkData {
  const collection = { ...fixtureWork, type: av ? "av" as const : "game" as const };
  return { collection, providerConnected: true, covers: null, related: null, position: 2, total: 3, case: { title: collection.name, platform: av ? "av" : "sw2", front: "/front", spine: av ? "/spine" : null, back: av ? "/back" : null, privacy: false }, artworks: [], av: av ? { collectionId: collection.id, revision: 1, productCode: "ABC-123", titleJa: null, maker: "메이커", label: "레이블", series: null, releaseDate: "2026-09-01", genres: ["태그"], people: [], makerCount: 1, labelCount: 1, seriesCount: 0 } : null };
}
function callbacks(): WorkActions {
  return { onClose: vi.fn(), onStep: vi.fn(), onEdit: vi.fn(), onShowcase: vi.fn(), onManage: () => [], onSave: vi.fn().mockResolvedValue(undefined), onOpenPerson: vi.fn(), onOpenCollection: vi.fn(), onCopyCode: vi.fn() };
}
function view(data = value(), actions = callbacks()) {
  return { actions, ...render(<PrivacyProvider privacyMode={false} setPrivacyMode={vi.fn()}><CollectionWorkScreen data={data} pending={false} actions={actions} /></PrivacyProvider>) };
}
describe("merged work screen", () => {
  it("shows position, a dock that pushes the stage, and object modes with no empty divider", async () => {
    const { container } = view(); const user = userEvent.setup();
    expect(container.querySelector(".asset-viewer__position")).toHaveTextContent("2 / 3");
    expect(screen.getByRole("complementary", { name: "작품 정보" })).toBeInTheDocument();
    expect(container.querySelector(".work-surface")).toHaveClass("work-surface--info");
    await user.click(screen.getByRole("button", { name: "정보" }));
    expect(screen.queryByRole("complementary", { name: "작품 정보" })).toBeNull();
    await user.click(screen.getByRole("button", { name: "안쪽" }));
    expect(screen.getByRole("group", { name: "케이스" })).toHaveAttribute("aria-expanded", "true");
    expect(container.querySelector(".cart-slot")).not.toBeNull();
    expect(container.querySelector(".work-strip-separator")).toBeNull();
    expect(screen.queryByText("개요는 표시하지 않음")).toBeNull();
    await user.click(screen.getByRole("button", { name: "케이스" }));
    expect(screen.getByRole("group", { name: "케이스" })).toHaveAttribute("aria-expanded", "false");
  });
  it("keeps the same screen and old work until the incoming cover decodes", async () => {
    const actions = callbacks(); const first = value(); const second = { ...value(), collection: { ...fixtureWork, id: "game-2", name: "게임 둘" }, case: { ...first.case, title: "게임 둘", front: "/next" }, position: 3 };
    const { rerender, container } = view(first, actions); const root = screen.getByRole("article");
    rerender(<PrivacyProvider privacyMode={false} setPrivacyMode={vi.fn()}><CollectionWorkScreen data={second} pending={false} actions={actions} /></PrivacyProvider>);
    expect(screen.getByRole("heading", { name: "게임 하나" })).toBeInTheDocument();
    expect(container.querySelector('.work-surface:not([aria-hidden="true"])')).toHaveAttribute("inert");
    const incoming = container.querySelector<HTMLImageElement>('img[src="/next"]')!;
    let decode!: () => void; Object.defineProperty(incoming, "decode", { value: () => new Promise<void>(resolve => { decode = resolve; }) });
    fireEvent.load(incoming); expect(screen.getByRole("heading", { name: "게임 하나" })).toBeInTheDocument();
    await act(async () => decode());
    expect(screen.getByRole("heading", { name: "게임 둘" })).toBeInTheDocument();
    expect(screen.getByRole("article")).toBe(root);
    expect(document.activeElement).toBe(root);
    expect(container.querySelector(".asset-viewer__position")).toHaveTextContent("3 / 3");
  });
  it("steps by screen arrows but rotates by case arrows", () => {
    const { actions } = view(); const root = screen.getByRole("article");
    fireEvent.keyDown(root, { key: "ArrowRight" }); expect(actions.onStep).toHaveBeenCalledWith(1);
    actions.onStep = vi.fn();
    fireEvent.keyDown(screen.getByRole("group", { name: "케이스" }), { key: "ArrowLeft" }); expect(actions.onStep).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "이전 작품" })); expect(actions.onStep).toHaveBeenCalledWith(-1);
  });
  it("shows AV's flat back/spine/front sheet and its inside disc", async () => {
    const { container } = view(value(true));
    await act(async () => { container.querySelectorAll(".work-flat img").forEach(img => fireEvent.load(img)); });
    await userEvent.click(screen.getByRole("button", { name: "펼친 표지" }));
    const flat = screen.getByLabelText("펼친 표지", { selector: "div" });
    expect(within(flat).getAllByRole("img").map(img => img.getAttribute("src"))).toEqual(["/back", "/spine", "/front"]);
    await userEvent.click(screen.getByRole("button", { name: "안쪽" }));
    expect(container.querySelector(".disc")).not.toBeNull();
  });
  it("keeps the case until a picked screenshot decodes, then displays it large", async () => {
    const data = { ...value(), artworks: [{ id: "screenshot", kind: "screenshot", selected: false }] };
    const { container } = view(data);
    expect(container.querySelector(".work-strip-separator")).not.toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "아트워크 1" }));
    expect(screen.getByRole("group", { name: "케이스" })).toBeInTheDocument();
    const image = container.querySelector<HTMLImageElement>(".work-art img")!;
    let ready!: () => void;
    Object.defineProperty(image, "decode", { value: () => new Promise<void>(resolve => { ready = resolve; }) });
    fireEvent.load(image);
    expect(screen.getByRole("group", { name: "케이스" })).toBeInTheDocument();
    await act(async () => ready());
    expect(screen.queryByRole("group", { name: "케이스" })).toBeNull();
    expect(screen.getByRole("img", { name: "게임 하나 아트워크" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "아트워크 1" })).toHaveAttribute("aria-pressed", "true");
  });
  it("edits existing score and memo through callbacks without adding missing rows", async () => {
    const { actions } = view(); const user = userEvent.setup();
    await user.clear(screen.getByRole("spinbutton", { name: "별점" })); await user.type(screen.getByRole("spinbutton", { name: "별점" }), "4.5");
    await user.click(screen.getByRole("button", { name: "저장" }));
    expect(actions.onSave).toHaveBeenCalledWith(fixtureWork, 4.5, "기존 메모");
    expect(screen.queryByText("상태")).toBeNull(); expect(screen.queryByText("기기")).toBeNull();
  });
  it("masks the painted artwork immediately when privacy changes", () => {
    const first = value(); const { rerender } = view(first);
    rerender(<PrivacyProvider privacyMode setPrivacyMode={vi.fn()}><CollectionWorkScreen data={{ ...first, case: { ...first.case, privacy: true } }} pending={false} actions={callbacks()} /></PrivacyProvider>);
    expect(screen.queryByRole("img")).toBeNull();
  });
});
