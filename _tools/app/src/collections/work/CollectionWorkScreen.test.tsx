import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CollectionWorkScreen, type CollectionWorkData, type WorkActions } from "./CollectionWorkScreen";
import type { CollectionSummary } from "../../library/types";
import { defaultRecord } from "./WorkRecord";
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
  return { onClose: vi.fn(), onStep: vi.fn(), onEdit: vi.fn(), onShowcase: vi.fn(), onManage: () => [], onSave: vi.fn().mockImplementation(async (collection, edit) => ({ ...defaultRecord(collection), [edit.field === "myScore" ? "myScore" : edit.field]: edit.value })), onOpenPerson: vi.fn(), onOpenCollection: vi.fn(), onCopyCode: vi.fn() };
}
it.each(["av", "game", "movie"] as const)("uses only AV's shown case front for the shared backdrop (%s)", async type => {
  const base = value(type === "av");
  const data = {...base, collection: {...base.collection, type}};
  const {container, rerender} = view(data);
  const image = container.querySelector<HTMLImageElement>(".work-backdrop img");
  if (type !== "av") { expect(image).toBeNull(); return; }
  expect(image).toHaveAttribute("src", data.case.front);
  expect(image).not.toHaveClass("is-painted");
  await act(async () => fireEvent.load(image!));
  expect(image).toHaveClass("is-painted");
  rerender(<PrivacyProvider privacyMode setPrivacyMode={vi.fn()}><CollectionWorkScreen data={{...data, case: {...data.case, privacy: true}}} pending={false} actions={callbacks()}/></PrivacyProvider>);
  expect(container.querySelector(".work-backdrop")).toBeNull();
});
function view(data = value(), actions = callbacks()) {
  return { actions, ...render(<PrivacyProvider privacyMode={false} setPrivacyMode={vi.fn()}><CollectionWorkScreen data={data} pending={false} actions={actions} /></PrivacyProvider>) };
}
it('closes only an open case from empty stage layers, preserves closed rotation/zoom, and leaves case and controls working', () => {
  const { container, actions } = view();
  const object = screen.getByRole('group', { name: '케이스' });
  const stage = container.querySelector('.work-stage')!;
  const layer = container.querySelector('.work-case-slot')!;
  const zoom = container.querySelector('.work-zoom-object')!;
  fireEvent.keyDown(object, { key: 'ArrowRight' });
  const angle = object.getAttribute('data-angle');
  fireEvent.wheel(stage, { deltaY: -100 }); const scale = zoom.getAttribute('data-zoom');
  for (const empty of [stage, layer, zoom]) fireEvent.click(empty);
  expect(object).toHaveAttribute('aria-expanded', 'false'); expect(object).toHaveAttribute('data-angle', angle);
  expect(zoom).toHaveAttribute('data-zoom', scale);
  fireEvent.keyDown(object, { key: 'Enter' }); expect(object).toHaveAttribute('aria-expanded', 'true');
  fireEvent.click(object.querySelector('.k-front')!); expect(object).toHaveAttribute('aria-expanded', 'true');
  fireEvent.click(screen.getByRole('button', { name: '다음 작품' }));
  expect(actions.onStep).toHaveBeenCalledWith(1); expect(object).toHaveAttribute('aria-expanded', 'true');
  fireEvent.click(layer); expect(object).toHaveAttribute('aria-expanded', 'false');
  expect(object).toHaveAttribute('data-angle', angle); expect(zoom).toHaveAttribute('data-zoom', scale);
  const mouse = { pointerId: 7, pointerType: 'mouse', button: 0, clientX: 100, clientY: 100 };
  fireEvent.pointerDown(object, mouse); fireEvent.pointerUp(object, mouse);
  fireEvent.click(stage, { detail: 1 }); // Capture may retarget the synthetic click to the stage.
  expect(object).toHaveAttribute('aria-expanded', 'true');
  fireEvent.pointerDown(stage, mouse); fireEvent.pointerUp(stage, mouse); fireEvent.click(stage, { detail: 1 });
  expect(object).toHaveAttribute('aria-expanded', 'false');
});
describe("merged work screen", () => {
  it("zooms smoothly with fractional wheel deltas, clamps, resets both pose and zoom, and leaves outside scrolling alone", () => {
    const first = value(); const actions = callbacks(); const { container, rerender } = view(first, actions);
    const stage = container.querySelector('.work-stage')!;
    const zoom = () => Number(container.querySelector('.work-zoom-object')!.getAttribute('data-zoom'));
    fireEvent.wheel(stage, { deltaY: -.5 }); expect(zoom()).toBeGreaterThan(1); expect(zoom()).toBeLessThan(1.01);
    const wheel = new WheelEvent('wheel', { deltaY: -100000, bubbles: true, cancelable: true });
    fireEvent(stage, wheel); expect(wheel.defaultPrevented).toBe(true); expect(zoom()).toBe(2.5);
    fireEvent.wheel(stage, { deltaY: 100000 }); expect(zoom()).toBe(.6);
    const outside = new WheelEvent('wheel', { deltaY: 100, bubbles: true, cancelable: true });
    fireEvent(screen.getByRole('complementary'), outside); expect(outside.defaultPrevented).toBe(false);
    fireEvent.keyDown(screen.getByRole('group', { name: '케이스' }), { key: 'ArrowRight' });
    fireEvent.click(screen.getByRole('button', { name: '정면으로' }));
    expect(zoom()).toBe(1); expect(screen.getByRole('group', { name: '케이스' })).toHaveAttribute('data-angle', '0');
    fireEvent.wheel(stage, { deltaY: -100 });
    const next = { ...first, collection: { ...first.collection, id: 'another' }, case: { ...first.case, front: null } };
    rerender(<PrivacyProvider privacyMode={false} setPrivacyMode={vi.fn()}><CollectionWorkScreen data={next} pending={false} actions={actions}/></PrivacyProvider>);
    expect([...container.querySelectorAll('.work-zoom-object')].every(node => node.getAttribute('data-zoom') === '1')).toBe(true);
  });
  it("zooms open and flat objects but leaves the standalone artwork view unchanged", async () => {
    const data = { ...value(true), case: { ...value(true).case, privacy: true }, artworks: [{ id: 'art', kind: 'screenshot' as const, selected: false }] };
    const { container } = view(data);
    const stage = container.querySelector('.work-stage')!;
    const object = container.querySelector('.work-zoom-object')!;
    fireEvent.keyDown(screen.getByRole('group', { name: '케이스' }), { key: 'Enter' });
    fireEvent.wheel(stage, { deltaY: -100 }); expect(Number(object.getAttribute('data-zoom'))).toBeGreaterThan(1);
    fireEvent.click(screen.getByRole('button', { name: '펼친 표지' }));
    fireEvent.wheel(stage, { deltaY: -100 }); const flatZoom = object.getAttribute('data-zoom');
    expect(object.querySelector('.work-flat')).not.toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '아트워크 1' }));
    const wheel = new WheelEvent('wheel', { deltaY: -100, bubbles: true, cancelable: true });
    fireEvent(stage, wheel); expect(wheel.defaultPrevented).toBe(false); expect(object.getAttribute('data-zoom')).toBe(flatZoom);
    expect(container.querySelector('.work-backdrop')).toBeNull();
  });
  it("updates metadata in the painted surface without busy states or slot swaps", async () => {
    const first = { ...value(), record: { status: "playing", ownedPlatform: "PC", myScore: 3.5, memo: "메모" } };
    const actions = callbacks(); const { container, rerender } = view(first, actions);
    fireEvent.keyDown(screen.getByRole("group", { name: "케이스" }), { key: "Enter" });
    const object = screen.getByRole("group", { name: "케이스" });
    const label = screen.getByRole("button", { name: "상태" });
    const busy: string[] = [];
    const root = screen.getByRole("article");
    const observer = new MutationObserver(records => busy.push(...records.map(record => record.oldValue!)));
    observer.observe(root, { attributes: true, attributeFilter: ["aria-busy"], attributeOldValue: true });
    const next = { ...first, record: { ...first.record, status: "done" }, collection: { ...first.collection, updatedAt: "new" } };
    rerender(<PrivacyProvider privacyMode={false} setPrivacyMode={vi.fn()}><CollectionWorkScreen data={next} pending={false} actions={actions} /></PrivacyProvider>);
    await act(async () => undefined);
    expect(root).toHaveAttribute("aria-busy", "false");
    expect(busy).not.toContain("true");
    expect(container.querySelectorAll(".work-surface")).toHaveLength(1);
    expect(screen.getByRole("group", { name: "케이스" })).toBe(object);
    expect(object).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("button", { name: "상태" })).toBe(label);
    expect(label).toHaveTextContent("다 함");
    expect(screen.getByRole("button", { name: "편집" })).not.toBeDisabled();
    observer.disconnect();
  });
  it("hides position, shows a dock that pushes the stage, and object modes with no empty divider", async () => {
    const { container } = view(); const user = userEvent.setup();
    expect(container.querySelector(".asset-viewer__position")).toBeNull();
    expect(screen.getByRole("complementary", { name: "작품 정보" })).toBeInTheDocument();
    expect(container.querySelector(".work-surface")).toHaveClass("work-surface--info");
    await user.click(screen.getByRole("button", { name: "정보" }));
    expect(screen.queryByRole("complementary", { name: "작품 정보" })).toBeNull();
    fireEvent.keyDown(screen.getByRole("group", { name: "케이스" }), { key: "Enter" });
    expect(screen.getByRole("group", { name: "케이스" })).toHaveAttribute("aria-expanded", "true");
    expect(container.querySelector(".cart-slot")).not.toBeNull();
    expect(container.querySelector(".work-strip")).toBeNull();
    expect(container.querySelector(".work-stage")).toHaveClass("work-stage--no-strip");
    expect(screen.queryByText("개요는 표시하지 않음")).toBeNull();
    fireEvent.click(container.querySelector(".work-stage")!);
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
    expect(container.querySelector(".asset-viewer__position")).toBeNull();
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
    fireEvent.click(screen.getByRole("button", { name: "펼친 표지" }));
    fireEvent.keyDown(screen.getByRole("group", { name: "케이스" }), { key: "Enter" });
    expect(container.querySelector(".disc")).not.toBeNull();
  });
  it("keeps the case until a picked screenshot decodes, then displays it large", async () => {
    const data = { ...value(), artworks: [{ id: "screenshot", kind: "screenshot", selected: false }] };
    const { container } = view(data);
    expect(container.querySelector(".work-strip-separator")).toBeNull();
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
    fireEvent.click(screen.getByRole("button", {name: "아트워크 1"}));
    expect(screen.getByRole("group", {name: "케이스"})).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(screen.getByRole("button", {name: "아트워크 1"}));
    await act(async () => fireEvent.load(container.querySelector(".work-art img")!));
    expect(screen.queryByRole("group", {name: "케이스"})).toBeNull();
    fireEvent.click(screen.getByRole("img", {name: "게임 하나 아트워크"}));
    expect(screen.queryByRole("group", {name: "케이스"})).toBeNull();
    fireEvent.click(container.querySelector(".work-art")!);
    expect(screen.getByRole("group", {name: "케이스"})).toHaveAttribute("aria-expanded", "false");
  });
  it("auto-saves the clicked stars, preserves a stored half and offers quiet record menus", async () => {
    const { actions, container } = view(); const user = userEvent.setup();
    expect(container.querySelectorAll('.work-stars button > span')[3]).toHaveStyle({width:"50%"});
    expect(screen.queryByRole("spinbutton")).toBeNull(); expect(screen.queryByRole("button",{name:"저장"})).toBeNull();
    await user.click(screen.getByRole("button", {name:"별점 5점"}));
    expect(actions.onSave).toHaveBeenCalledWith(fixtureWork,{field:"myScore",value:5});
    await user.click(screen.getByRole("button", {name:"별점 5점"}));
    expect(actions.onSave).toHaveBeenLastCalledWith(fixtureWork,{field:"myScore",value:null});
    await user.click(screen.getByRole("button",{name:"상태"}));
    await user.click(screen.getByRole("menuitemradio",{name:"하는 중"}));
    expect(actions.onSave).toHaveBeenLastCalledWith(fixtureWork,{field:"status",value:"playing"});
    expect(screen.getByRole("button",{name:"소유 기기"})).toBeInTheDocument();
  });
  it("keeps the manga screen and old decoded element until the next volume is ready", async () => {
    const first = value();
    const volumes = [1,2].map(n => ({id:`v${n}`,volumeNumber:n,editionIndex:0,displayLabel:String(n),coverArtworkId:`art-${n}`,localReleaseDate:null,isbn13:null,releaseStatus:null}));
    const manga = {volumes,activeVolumeId:"v1",editionIndex:0,focuses:[],ownedNumbers:[1],scope:"",revision:"",ownership:null,management:null};
    const one:CollectionWorkData={...first,collection:{...fixtureWork,type:"manga"},case:{...first.case,front:"http://lakomics.localhost/work-artwork/art-1"},manga,position:1,total:2};
    const two:CollectionWorkData={...one,case:{...one.case,front:"http://lakomics.localhost/work-artwork/art-2"},manga:{...manga,activeVolumeId:"v2"},position:2};
    const actions=callbacks(); const {container,rerender}=view(one,actions); const root=screen.getByRole("article",{name:"만화 작품 화면"});
    const painted=container.querySelector('.manga-bb-front img');
    const oldBackdrop = container.querySelector<HTMLImageElement>('.work-backdrop img')!;
    expect(oldBackdrop.src).toBe((painted as HTMLImageElement).src);
    await act(async () => fireEvent.load(oldBackdrop));
    expect(oldBackdrop).toHaveClass('is-painted');
    fireEvent.wheel(container.querySelector('.manga-work-stage')!, { deltaY: -100 });
    const volumeZoom = container.querySelector('.work-zoom-object')!.getAttribute('data-zoom');
    rerender(<PrivacyProvider privacyMode={false} setPrivacyMode={vi.fn()}><CollectionWorkScreen data={two} pending={false} actions={actions}/></PrivacyProvider>);
    expect(screen.getByRole("heading", { name: "게임 하나 1권" })).toBeInTheDocument();
    expect(painted).toBeVisible();
    const incoming=container.querySelector<HTMLImageElement>('.work-surface[aria-hidden="true"] .manga-bb-front img')!;
    let decode!:()=>void; Object.defineProperty(incoming,"decode",{value:()=>new Promise<void>(resolve=>{decode=resolve;})});
    fireEvent.load(incoming);
    await act(async () => { container.querySelectorAll('.work-surface[aria-hidden="true"] .manga-bb-back img, .work-surface[aria-hidden="true"] .manga-jspine-illustration img').forEach(image => fireEvent.load(image)); });
    expect(screen.getByRole("heading", { name: "게임 하나 1권" })).toBeInTheDocument();
    await act(async()=>decode());
    expect(screen.getByRole("article")).toBe(root);
    expect(screen.getByRole("heading", { name: "게임 하나 2권" })).toBeInTheDocument();
    expect(root.querySelector(".asset-viewer__position")).toBeNull();
    expect(incoming).toBeVisible();
    expect([...container.querySelectorAll('.work-zoom-object')].every(node => node.getAttribute('data-zoom') === volumeZoom)).toBe(true);
    expect(oldBackdrop).toHaveClass('is-painted');
    const newBackdrop = container.querySelector<HTMLImageElement>('.work-backdrop img:not(.is-painted)')!;
    let backdropDecode!: () => void;
    Object.defineProperty(newBackdrop, 'decode', { value: () => new Promise<void>(resolve => { backdropDecode = resolve; }) });
    fireEvent.load(newBackdrop); expect(oldBackdrop).toHaveClass('is-painted');
    await act(async () => backdropDecode());
    expect(newBackdrop).toHaveClass('is-painted'); expect(oldBackdrop).not.toHaveClass('is-painted');
    fireEvent.keyDown(screen.getByRole('group', { name: '책' }), { key: 'ArrowRight' });
    fireEvent.click(screen.getByRole('button', { name: '정면으로' }));
    expect(screen.getByRole('group', { name: '책' })).toHaveAttribute('data-angle', '0');
    expect([...container.querySelectorAll('.work-zoom-object')].every(node => node.getAttribute('data-zoom') === '1')).toBe(true);
    rerender(<PrivacyProvider privacyMode setPrivacyMode={vi.fn()}><CollectionWorkScreen data={{...two, case: {...two.case, privacy: true}}} pending={false} actions={actions}/></PrivacyProvider>);
    expect(container.querySelector('.work-backdrop')).toBeNull();
    fireEvent.keyDown(root,{key:"ArrowLeft"}); expect(actions.onStep).toHaveBeenCalledWith(-1);
  });

  it("masks the painted artwork immediately when privacy changes", () => {
    const first = value(); const { rerender } = view(first);
    rerender(<PrivacyProvider privacyMode setPrivacyMode={vi.fn()}><CollectionWorkScreen data={{ ...first, case: { ...first.case, privacy: true } }} pending={false} actions={callbacks()} /></PrivacyProvider>);
    expect(screen.queryAllByRole("img").filter(element => element.tagName === "IMG")).toHaveLength(0);
  });
});

function filmValue(): CollectionWorkData {
  const game = value();
  return { ...game, collection: { ...fixtureWork, type: "movie", name: "영화 하나", director: "감독 이름", productionCompany: "제작사 이름", runtimeMinutes: 81, genres: "애니메이션 · 스릴러", overview: "한국어 개요 전체 내용" }, case: { ...game.case, platform: "film", title: "영화 하나", spine: null, back: null } };
}
it.each(["game", "av", "movie"] as const)("keeps only short key rows inside a %s case while the full record stays in the dock", type => {
  const original = type === "movie" ? filmValue() : value(type === "av");
  const data = { ...original, record: { status: null, ownedPlatform: "아주 긴 기기 이름".repeat(20), myScore: 3.5, memo: "긴 메모".repeat(100) } };
  const { container } = view(data);
  const slip = container.querySelector(".slip")!;
  const card = container.querySelector(".card2")!;
  expect([...slip.querySelectorAll("dt")].map(node => node.textContent)).toEqual(type === "game" ? ["상태", "별점", "기기"] : ["상태", "별점"]);
  expect([...card.querySelectorAll("dt")].map(node => node.textContent)).toEqual(type === "game" ? ["개발사", "발매"] : type === "av" ? ["품번", "메이커", "발매"] : ["감독", "개봉", "러닝타임"]);
  expect(slip).not.toHaveTextContent(data.record.memo);
  expect(screen.getByRole("textbox", { name: "메모" })).toHaveValue(data.record.memo);
  expect(container.querySelector(".kase")).not.toHaveTextContent("태그");
  expect(container.querySelector(".kase")).not.toHaveTextContent("개요");
});
it("keeps the AV tray note to names only", () => {
  const original = value(true);
  const people = [{ id: "p", displayName: "이름만", role: "performer" as const, order: 0, creditName: "긴 크레딧", nameJa: "일본 이름", workCount: 20, portrait: null }];
  const { container } = view({ ...original, av: { ...original.av!, people } });
  expect(container.querySelector(".note")).toHaveTextContent("출연 · 감독이름만");
  expect(container.querySelector(".note")).not.toHaveTextContent("긴 크레딧");
  expect(container.querySelector(".note")).not.toHaveTextContent("일본 이름");
});
it("opens the film form with a plain disc case, concise facts and film record options", async () => {
  const data = filmValue(); const { container, actions } = view(data); const user = userEvent.setup();
  expect(screen.getByRole("article", { name: "영화 작품 화면" })).toBeInTheDocument();
  expect(container.querySelector(".asset-viewer__title small")).toHaveTextContent("감독 이름 · 9.1");
  expect(container.querySelector(".asset-viewer__position")).toBeNull();
  for (const name of ["쇼케이스", "편집", "작품 관리", "정면으로", "정보", "닫기"]) expect(screen.getByRole("button", { name })).toBeInTheDocument();
  fireEvent.keyDown(screen.getByRole("group", { name: "케이스" }), { key: "Enter" });
  expect(container.querySelector(".disc")).not.toBeNull();
  expect(container.querySelector(".cart-slot")).toBeNull();
  expect(container.querySelector("[data-spine-template]")).toBeNull();
  expect(container.querySelector(".k-spine .bare")).toHaveTextContent("영화 하나");
  expect(container.querySelector(".k-back img")).toBeNull();
  expect(container.querySelector(".note")).toBeNull();
  expect(container.querySelector(".card2")).toHaveTextContent("감독감독 이름개봉");
  expect(container.querySelector(".card2")).toHaveTextContent("러닝타임81분");
  const dock = within(screen.getByRole("complementary", { name: "작품 정보" }));
  expect(dock.getByRole("region", { name: "개요" })).toHaveTextContent(data.collection.overview!);
  expect(screen.queryByRole("button", { name: "소유 기기" })).toBeNull();
  await user.click(dock.getByRole("button", { name: "상태" }));
  for (const label of ["다 봄", "보는 중", "안 봄"]) expect(screen.getByRole("menuitemradio", { name: label })).toBeInTheDocument();
  await user.click(screen.getByRole("menuitemradio", { name: "보는 중" }));
  expect(actions.onSave).toHaveBeenCalledWith(data.collection, { field: "status", value: "watching" });
  expect(container.querySelector(".work-strip-separator")).toBeNull();
  expect(screen.queryByRole("button", { name: "펼친 표지" })).toBeNull();
});
it("holds a film's painted cover until the next film decodes without remounting", async () => {
  const first = filmValue(); const actions = callbacks(); const { container, rerender } = view(first, actions);
  const root = screen.getByRole("article"); const painted = container.querySelector('.k-front img');
  const second = { ...first, collection: { ...first.collection, id: "film-2", name: "영화 둘" }, case: { ...first.case, title: "영화 둘", front: "/film-next" }, position: 3 };
  rerender(<PrivacyProvider privacyMode={false} setPrivacyMode={vi.fn()}><CollectionWorkScreen data={second} pending={false} actions={actions} /></PrivacyProvider>);
  expect(painted).toBeVisible();
  expect(screen.getByRole("heading", { name: "영화 하나" })).toBeInTheDocument();
  const incoming = container.querySelector<HTMLImageElement>('img[src="/film-next"]')!;
  let decoded!: () => void; Object.defineProperty(incoming, "decode", { value: () => new Promise<void>(resolve => { decoded = resolve; }) });
  fireEvent.load(incoming); expect(screen.getByRole("heading", { name: "영화 하나" })).toBeInTheDocument();
  await act(async () => decoded());
  expect(screen.getByRole("article")).toBe(root);
  expect(screen.getByRole("heading", { name: "영화 둘" })).toBeInTheDocument();
  expect(incoming).toBeVisible();
  fireEvent.keyDown(root, { key: "ArrowLeft" }); expect(actions.onStep).toHaveBeenCalledWith(-1);
});
it("puts TV seasons and full overview in the dock, keeping seasons outside the case", async () => {
  const first = filmValue();
  const data = { ...first, tmdb: { movieId: 1, mediaType: "tv" as const, lastSyncedAt: null, series: { status: "Ended", lastAirDate: "2025-12-31", cast: ["주연"], seasons: [{ id: 1, seasonNumber: 1, name: "시즌 1", overview: "시즌 개요", airDate: "2020-01-01", posterPath: null, posterArtworkId: "season-cover", episodes: [{ id: 1, episodeNumber: 1, name: "첫 에피소드", overview: "에피소드 내용", airDate: "2020-01-01", runtimeMinutes: 40 }] }] } } };
  const { container } = view(data);
  const dock = screen.getByRole("complementary", { name: "작품 정보" });
  expect(within(dock).getByRole("region", { name: "시즌과 에피소드" })).toHaveTextContent("첫 에피소드");
  expect(container.querySelector(".kase")).not.toHaveTextContent("시즌 1");
  expect(dock).toHaveTextContent("최근 방영2025.12.31");
  await userEvent.dblClick(screen.getByRole("button", { name: /시즌 1.*1개 에피소드/ }));
  expect(screen.getByRole("dialog", { name: "시즌 포스터 표지 감상" })).toBeInTheDocument();
});
it("omits missing film facts and an empty overview note", () => {
  const data = filmValue(); view({ ...data, collection: { ...data.collection, director: null, productionCompany: null, runtimeMinutes: null, releaseDate: null, genres: null, overview: " " } });
  expect(document.querySelector(".card2 dl")).toBeEmptyDOMElement();
  expect(document.querySelector(".note")).toBeNull();
  expect(screen.queryByRole("region", { name: "개요" })).toBeNull();
});

describe("hero art band", () => {
  it.each(["game", "movie", "av", "manga"] as const)("uses a %s work's selected hero, with only films falling back to backdrop", async type => {
    const first = value();
    const data = { ...first, collection: { ...first.collection, type, selectedHeroArtworkId: "hero", selectedBackdropArtworkId: "backdrop" } };
    const { container, rerender } = view(data);
    const image = container.querySelector<HTMLImageElement>('.work-hero-band img')!;
    expect(image).toHaveAttribute("src", "http://lakomics.localhost/work-artwork/hero");
    expect(image).not.toBeVisible();
    let decode!: () => void;
    Object.defineProperty(image, "decode", { value: () => new Promise<void>(resolve => { decode = resolve; }) });
    fireEvent.load(image); expect(image).not.toBeVisible();
    await act(async () => decode()); expect(image).toBeVisible();
    const next = { ...data, collection: { ...data.collection, selectedHeroArtworkId: null } };
    rerender(<PrivacyProvider privacyMode={false} setPrivacyMode={vi.fn()}><CollectionWorkScreen data={next} pending={false} actions={callbacks()} /></PrivacyProvider>);
    const incoming = container.querySelector('.work-surface[aria-hidden="true"]')!;
    expect(incoming.querySelector('.work-hero-band img')?.getAttribute("src") ?? null).toBe(type === "movie" ? "http://lakomics.localhost/work-artwork/backdrop" : null);
  });
  it("keeps the same painted hero and case until both incoming images decode", async () => {
    const first = { ...value(), collection: { ...fixtureWork, selectedHeroArtworkId: "hero-1" } };
    const actions = callbacks(); const { container, rerender } = view(first, actions);
    const oldHero = container.querySelector<HTMLImageElement>('.work-hero-band img')!;
    await act(async () => fireEvent.load(oldHero));
    const root = screen.getByRole("article"); const oldCase = container.querySelector('.k-front img');
    const second = { ...first, collection: { ...fixtureWork, id: "two", name: "게임 둘", selectedHeroArtworkId: "hero-2" }, case: { ...first.case, title: "게임 둘", front: "/next-cover" } };
    rerender(<PrivacyProvider privacyMode={false} setPrivacyMode={vi.fn()}><CollectionWorkScreen data={second} pending={false} actions={actions} /></PrivacyProvider>);
    const incoming = container.querySelector('.work-surface[aria-hidden="true"]')!;
    const nextHero = incoming.querySelector<HTMLImageElement>('.work-hero-band img')!;
    const nextCase = incoming.querySelector<HTMLImageElement>('.k-front img')!;
    let heroDecoded!: () => void; let caseDecoded!: () => void;
    Object.defineProperty(nextHero, "decode", { value: () => new Promise<void>(resolve => { heroDecoded = resolve; }) });
    Object.defineProperty(nextCase, "decode", { value: () => new Promise<void>(resolve => { caseDecoded = resolve; }) });
    fireEvent.load(nextHero); fireEvent.load(nextCase);
    await act(async () => caseDecoded());
    expect(oldHero).toBeVisible(); expect(oldCase).toBeVisible(); expect(nextHero).not.toBeVisible();
    expect(screen.getByRole("heading", { name: "게임 하나" })).toBeInTheDocument();
    await act(async () => heroDecoded());
    expect(screen.getByRole("article")).toBe(root);
    expect(nextHero).toBeVisible(); expect(nextCase).toBeVisible(); expect(oldHero).not.toBeVisible();
    expect(screen.getByRole("heading", { name: "게임 둘" })).toBeInTheDocument();
  });
  it("has no band without art and removes a decoded band immediately in privacy mode", async () => {
    const { container, rerender } = view(); expect(container.querySelector('.work-hero-band')).toBeNull();
    const hero = { ...value(), collection: { ...fixtureWork, selectedHeroArtworkId: "hero" } };
    const privacy = (data: CollectionWorkData) => <PrivacyProvider privacyMode={data.case.privacy} setPrivacyMode={vi.fn()}><CollectionWorkScreen data={data} pending={false} actions={callbacks()} /></PrivacyProvider>;
    rerender(privacy(hero));
    await act(async () => { container.querySelectorAll('.work-surface[aria-hidden="true"] img').forEach(image => fireEvent.load(image)); });
    expect(container.querySelector('.work-hero-band img')).toBeVisible();
    rerender(privacy({ ...hero, case: { ...hero.case, privacy: true } }));
    expect(container.querySelector('.work-hero-band')).toBeNull();
  });
  it("settles unavailable hero art so navigation remains usable", async () => {
    const { container, rerender } = view();
    const next = { ...value(), collection: { ...fixtureWork, id: "two", name: "게임 둘", selectedHeroArtworkId: "failed" }, case: { ...value().case, title: "게임 둘", front: "/next" } };
    rerender(<PrivacyProvider privacyMode={false} setPrivacyMode={vi.fn()}><CollectionWorkScreen data={next} pending={false} actions={callbacks()} /></PrivacyProvider>);
    await act(async () => { fireEvent.error(container.querySelector('.work-surface[aria-hidden="true"] .work-hero-band img')!); fireEvent.load(container.querySelector('img[src="/next"]')!); });
    expect(screen.getByRole("heading", { name: "게임 둘" })).toBeInTheDocument();
    expect(container.querySelector('.work-surface:not([aria-hidden="true"]) .work-hero-band')).not.toBeVisible();
  });
});

it("rotates the focused manga book while screen arrows change volumes, and the front button resets it", async () => {
  const first = value();
  const manga = { volumes: [{ id: "v1", volumeNumber: 1, editionIndex: 0, displayLabel: "1", coverArtworkId: "cover", localReleaseDate: null, isbn13: null, releaseStatus: null }], activeVolumeId: "v1", editionIndex: 0, focuses: [], ownedNumbers: null, scope: "", revision: "", ownership: null, management: null };
  const { actions } = view({ ...first, collection: { ...fixtureWork, type: "manga", author: "작가" }, manga });
  const book = screen.getByRole("group", { name: "책" }); book.focus();
  fireEvent.keyDown(book, { key: "ArrowRight" });
  expect(book).toHaveAttribute("data-angle", "15"); expect(actions.onStep).not.toHaveBeenCalled();
  fireEvent.click(book); expect(book).toHaveAttribute("data-angle", "15");
  await userEvent.click(screen.getByRole("button", { name: "정면으로" })); expect(book).toHaveAttribute("data-angle", "0");
  const root = screen.getByRole("article"); root.focus(); fireEvent.keyDown(root, { key: "ArrowLeft" });
  expect(actions.onStep).toHaveBeenCalledWith(-1);
});

it("reuses an already decoded hero when a surface is reused for another work with the same art", async () => {
  const base = { ...value(), collection: { ...fixtureWork, selectedHeroArtworkId: "shared-hero" } };
  const actions = callbacks(); const { container, rerender } = view(base, actions);
  const originalHero = container.querySelector('.work-hero-band img')!;
  await act(async () => fireEvent.load(originalHero));
  const show = (n: number) => rerender(<PrivacyProvider privacyMode={false} setPrivacyMode={vi.fn()}><CollectionWorkScreen data={{ ...base, collection: { ...base.collection, id: `game-${n}`, name: `게임 ${n}` }, case: { ...base.case, front: `/cover-${n}`, title: `게임 ${n}` } }} pending={false} actions={actions} /></PrivacyProvider>);
  show(2);
  await act(async () => { container.querySelectorAll('.work-surface[aria-hidden="true"] .work-hero-band img, img[src="/cover-2"]').forEach(image => fireEvent.load(image)); });
  expect(screen.getByRole("heading", { name: "게임 2" })).toBeInTheDocument();
  show(3);
  await act(async () => fireEvent.load(container.querySelector('img[src="/cover-3"]')!));
  expect(screen.getByRole("heading", { name: "게임 3" })).toBeInTheDocument();
  expect(originalHero).toBeVisible();
});

it("waits for a fresh hero decode when a pending surface changes away from and back to that art", async () => {
  const base = { ...value(), collection: { ...fixtureWork, selectedHeroArtworkId: "hero-a" } };
  const actions = callbacks(); const { container, rerender } = view(base, actions);
  await act(async () => fireEvent.load(container.querySelector('.work-hero-band img')!));
  const show = (name: string, hero: string) => rerender(<PrivacyProvider privacyMode={false} setPrivacyMode={vi.fn()}><CollectionWorkScreen data={{ ...base, collection: { ...base.collection, id: name, name, selectedHeroArtworkId: hero }, case: { ...base.case, front: `/cover-${name}`, title: name } }} pending={false} actions={actions} /></PrivacyProvider>);
  show("게임 둘", "hero-d");
  await act(async () => container.querySelectorAll('.work-surface[aria-hidden="true"] .work-hero-band img, img[src="/cover-게임 둘"]').forEach(image => fireEvent.load(image)));
  expect(screen.getByRole("heading", { name: "게임 둘" })).toBeInTheDocument();
  show("취소된 게임", "hero-b");
  const incomingHero = container.querySelector<HTMLImageElement>('.work-surface[aria-hidden="true"] .work-hero-band img')!;
  let cancelled!: () => void;
  Object.defineProperty(incomingHero, "decode", { configurable: true, value: () => new Promise<void>(resolve => { cancelled = resolve; }) });
  fireEvent.load(incomingHero);
  show("게임 셋", "hero-a");
  await act(async () => { fireEvent.load(container.querySelector('img[src="/cover-게임 셋"]')!); cancelled(); });
  expect(screen.getByRole("heading", { name: "게임 둘" })).toBeInTheDocument();
  Object.defineProperty(incomingHero, "decode", { value: () => Promise.resolve() });
  await act(async () => fireEvent.load(incomingHero));
  expect(screen.getByRole("heading", { name: "게임 셋" })).toBeInTheDocument(); expect(incomingHero).toBeVisible();
});
