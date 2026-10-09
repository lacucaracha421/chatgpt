import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { PrivacyProvider } from "../../privacy/PrivacyContext";
import type { AvGateway, AvPerformerPage as PerformerData, AvPerformerProfile, PersonProfileState } from "../avTypes";
import { AvPerformerPage } from "./AvPerformerPage";

vi.mock("../../library/client", () => ({ libraryGateway: { listAvFavorites: vi.fn().mockResolvedValue([]), setAvFavorite: vi.fn().mockResolvedValue(undefined) } }));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn().mockResolvedValue(undefined) }));
afterEach(() => { cleanup(); localStorage.clear(); vi.clearAllMocks(); });
const profile: AvPerformerProfile = {
  personId: "p", source: "stashdb", status: "matched", stashdbId: "stash-p", name: "배우", aliases: [], birthDate: "2000-04-12", heightCm: 158, bandIn: null, waistIn: null, hipIn: null, cup: null, breastType: "NATURAL", careerStart: 2024, careerEnd: null, urls: [], images: [], candidates: [], fetchedAt: "2026-09-30T00:00:00Z",
};
function performer(id = "p"): PerformerData {
  return {
    person: { id, displayName: id === "p" ? "배우" : "다음 배우", nameJa: "日本名", portrait: null, memo: "기존 메모", fanzaActressId: "123", wikidataId: "Q123" },
    stats: { workCount: 14, firstRelease: "2024-01-01", lastRelease: "2026-09-30", averageScore: 4 },
    works: Array.from({ length: 14 }, (_, index) => ({ collectionId: `work-${index}`, name: `작품 ${index}`, productCode: `CODE-${index}`, releaseDate: `2026-09-${String(30 - index).padStart(2, "0")}`, frontArtworkId: `front-${index}`, spineArtworkId: `spine-${index}`, backArtworkId: null, coverRevision: "r1", role: "performer", solo: index % 2 === 0 })),
    coPerformers: [{ id: "co", displayName: "함께 나온 배우", count: 3, portrait: null }], labels: [{ name: "레이블 이름", count: 5 }],
  };
}
function gateway(overrides: Partial<AvGateway> = {}): AvGateway {
  return {
    getPerformer: vi.fn().mockResolvedValue(performer()), getPerformerProfile: vi.fn().mockResolvedValue(profile), getStashdbCredentialStatus: vi.fn().mockResolvedValue({ configured: false }),
    savePersonMemo: vi.fn().mockImplementation(async (_id, memo) => ({ ...performer(), person: { ...performer().person, memo } })), ...overrides,
  } as unknown as AvGateway;
}
function page(api: AvGateway, props: Partial<Parameters<typeof AvPerformerPage>[0]> = {}) {
  return <PrivacyProvider privacyMode={false} setPrivacyMode={vi.fn()}><AvPerformerPage personId="p" currentCollectionId="work-0" api={api} onBack={vi.fn()} {...props} /></PrivacyProvider>;
}
it("centres the profile column on the portrait, identity, facts and editable memo while retaining actions", async () => {
  const api = gateway({ getStashdbCredentialStatus: vi.fn().mockResolvedValue({ configured: true }), refreshPerformerProfile: vi.fn().mockResolvedValue(profile) });
  const back = vi.fn(); const { container } = render(page(api, { onBack: back }));
  const header = (await screen.findByRole("heading", { name: "배우", level: 1 })).closest("header")!;
  expect(within(header).getByText("日本名")).toBeVisible();
  expect(await within(header).findByText("158 cm")).toBeVisible();
  expect(within(header).getByLabelText("내 서재 통계")).toHaveTextContent("내 작품 14편 · 단독 7 · 발매 2024.1.1–9.30");
  expect(within(header).getByLabelText("내 서재 통계")).toHaveTextContent("평균 ★4.0");
  expect(within(header).queryByText("FANZA")).toBeNull();
  expect(within(header).queryByText("Wikidata")).toBeNull();
  expect(within(header).getByRole("button", { name: "즐겨찾기" }).parentElement).toHaveClass("av-performer-page__name-row");
  expect(within(header).getByText("기존 메모")).toBeVisible();
  expect(within(header).getByRole("button", { name: "사진 바꾸기" })).toBeVisible();
  fireEvent.click(within(header).getByText("기존 메모"));
  const memo = within(header).getByRole("textbox", { name: "배우 메모" });
  expect(header).toContainElement(memo);
  fireEvent.change(memo, { target: { value: "바꾼 메모" } }); fireEvent.click(within(header).getByRole("button", { name: "저장" }));
  await waitFor(() => expect(api.savePersonMemo).toHaveBeenCalledWith("p", "바꾼 메모"));
  expect(await within(header).findByText("바꾼 메모")).toBeVisible();
  fireEvent.click(within(header).getByRole("button", { name: "배우 메모 편집" }));
  fireEvent.change(within(header).getByRole("textbox"), { target: { value: "취소할 메모" } }); fireEvent.click(within(header).getByRole("button", { name: "취소" }));
  expect(within(header).getByText("바꾼 메모")).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "작품으로 돌아가기" })); expect(back).toHaveBeenCalledOnce();
  expect(container.querySelector(".av-performer-page__main")).toContainElement(screen.getByRole("group", { name: "배우 작품 선반" }));
});
it("uses the shared per-row menu and plank rows without remounting covers; filters solo and joint roles", async () => {
  const { container } = render(page(gateway())); const user = userEvent.setup();
  const shelf = await screen.findByRole("group", { name: "배우 작품 선반" });
  expect(shelf).toHaveAttribute("data-per-row", "8");
  const first = shelf.querySelector('[data-collection-id="work-0"]'); const cover = first?.querySelector(".cs-front img");
  await user.click(screen.getByRole("button", { name: "보기" }));
  for (let count = 5; count <= 12; count++) {
    fireEvent.change(screen.getByRole("slider", { name: "한 줄에" }), { target: { value: String(count) } });
    expect(shelf).toHaveAttribute("data-per-row", String(count));
    const rows = new Map<string, number>();
    shelf.querySelectorAll<HTMLElement>(".collection-list__cell").forEach(cell => rows.set(cell.style.gridRow, (rows.get(cell.style.gridRow) ?? 0) + 1));
    expect([...rows.values()].slice(0, -1).every(value => value === count)).toBe(true);
    expect(shelf.querySelectorAll(".collection-list__plank")).toHaveLength(Math.ceil(14 / count));
    expect(shelf.querySelector('[data-collection-id="work-0"]')).toBe(first);
    expect(first?.querySelector(".cs-front img")).toBe(cover);
  }
  await user.keyboard("{Escape}");
  fireEvent.click(screen.getByRole("radio", { name: "단독" })); expect(shelf.querySelectorAll("[data-collection-id]")).toHaveLength(7);
  expect(shelf.querySelector('[data-collection-id="work-1"]')).toBeNull();
  fireEvent.click(screen.getByRole("radio", { name: "공동 출연" })); expect(shelf.querySelectorAll("[data-collection-id]")).toHaveLength(7);
  expect(within(shelf).getAllByText(/· 공동 출연/)).toHaveLength(7);
  fireEvent.click(screen.getByRole("radio", { name: "전체" })); expect(shelf.querySelectorAll("[data-collection-id]")).toHaveLength(14);
  expect(container.querySelector(".dvd-case__stage")).toBeNull();
});
it("marks the originating work on its date line, turns on click, opens on double-click or Enter, and navigates co-performers", async () => {
  const open = vi.fn(), co = vi.fn(); render(page(gateway(), { onOpenCollection: open, onOpenPerformer: co }));
  const work = await screen.findByRole("button", { name: "작품 0 CODE-0" });
  expect(work.querySelector(".av-performer-page__code")).toHaveTextContent(/^CODE-0$/);
  expect(work.querySelector(".av-performer-page__date")).toHaveTextContent(/^9.30 · 이 작품$/);
  expect(work.querySelector(".ui-badge")).toBeNull();
  // The spine mounts after the front cover has had a paint opportunity.
  for (const front of work.querySelectorAll<HTMLImageElement>(".cs-front img, .collection-light-case img")) fireEvent.load(front);
  const realSpine = await waitFor(() => { const found = work.querySelector(".cs-spine img"); expect(found).not.toBeNull(); return found; });
  expect(realSpine?.getAttribute("src")).toContain("spine-0");
  fireEvent.click(work); expect(open).not.toHaveBeenCalled(); expect(work).toHaveAttribute("aria-selected", "true"); expect(work.querySelector(".collection-light-case")).toHaveAttribute("data-front", "true");
  fireEvent.doubleClick(work); expect(open).toHaveBeenCalledWith("work-0");
  fireEvent.keyDown(work, { key: "Enter" }); expect(open).toHaveBeenCalledTimes(2);
  fireEvent.click(screen.getByRole("button", { name: "함께 나온 배우 3편" })); expect(co).toHaveBeenCalledWith("co");
  expect(screen.getByText("레이블 이름")).toBeVisible();
});
it("sorts by release date through the shared menu", async () => {
  render(page(gateway())); const user = userEvent.setup();
  const shelf = await screen.findByRole("group", { name: "배우 작품 선반" });
  await user.click(screen.getByRole("button", { name: "정렬" })); await user.click(screen.getByRole("menuitemradio", { name: "발매일 오래된순" }));
  expect(shelf.querySelector("[data-collection-id]")).toHaveAttribute("data-collection-id", "work-13");
});
it("holds the previous performer inert until the next response", async () => {
  let resolveNext!: (value: PerformerData) => void;
  const pending = new Promise<PerformerData>(resolve => { resolveNext = resolve; });
  const api = gateway({ getPerformer: vi.fn().mockImplementation(id => id === "p" ? Promise.resolve(performer()) : pending) });
  const { rerender } = render(page(api)); const shelf = await screen.findByRole("group", { name: "배우 작품 선반" });
  rerender(page(api, { personId: "q" }));
  expect(screen.getByRole("heading", { name: "배우", level: 1 })).toBeVisible(); expect(shelf.closest("[inert]")).not.toBeNull();
  await act(async () => resolveNext(performer("q")));
  expect(screen.getByRole("heading", { name: "다음 배우", level: 1 })).toBeVisible(); expect(shelf.closest("[inert]")).toBeNull();
});


it("orders joint, current and private metadata on the date line without crowding the code", async () => {
  render(<PrivacyProvider privacyMode={true} setPrivacyMode={vi.fn()}><AvPerformerPage personId="p" currentCollectionId="work-1" api={gateway()} onBack={vi.fn()} /></PrivacyProvider>);
  const work = await screen.findByRole("button", { name: "작품 1 CODE-1" });
  expect(work.querySelector(".av-performer-page__code")).toHaveTextContent(/^CODE-1$/);
  expect(work.querySelector(".av-performer-page__date")).toHaveTextContent(/^9.29 · 공동 출연 · 이 작품 · 비공개$/);
  const other = screen.getByRole("button", { name: "작품 0 CODE-0" });
  expect(other.querySelector(".av-performer-page__date")).toHaveTextContent(/^9.30 · 비공개$/);
});

it("does not start current-work metadata with a separator when there is no date", async () => {
  const data = performer(); data.works[0]!.releaseDate = null;
  render(page(gateway({ getPerformer: vi.fn().mockResolvedValue(data) })));
  const work = await screen.findByRole("button", { name: "작품 0 CODE-0" });
  expect(work.querySelector(".av-performer-page__date")).toHaveTextContent(/^이 작품$/);
});

it('uses romanized primary names, Japanese subtitles and a capability-gated editor',async()=>{
  const data=performer();data.person.displayName='日本名';data.person.profile={name:'Roman Name'};
  data.coPerformers[0]={...data.coPerformers[0],displayName:'同僚',nameJa:'同僚',stashdbProfile:{name:'Co Roman'}};
  const state={...data.person,stashdbId:'s',stashdbProfile:{name:'Roman Name',heightCm:160},profile:{name:'Roman Name',heightCm:160},profileOverrides:{},profileFieldsSupported:true};
  const save=vi.fn().mockResolvedValue({...state,profile:{...state.profile,heightCm:170},profileOverrides:{heightCm:170}});
  const api=gateway({getPerformer:vi.fn().mockResolvedValue(data),getPersonProfileState:vi.fn().mockResolvedValue(state),setPersonProfileFields:save});
  render(page(api));
  await screen.findByRole('heading',{name:'Roman Name'});expect(screen.getByText('日本名',{selector:'p'})).toBeVisible();expect(screen.getByText('Co Roman')).toBeVisible();expect(screen.getByText('同僚')).toBeVisible();
  fireEvent.click(await screen.findByRole('button',{name:'프로필 편집'}));fireEvent.change(screen.getByLabelText('키 (cm)'),{target:{value:'170'}});fireEvent.click(screen.getByRole('button',{name:'저장'}));
  await waitFor(()=>expect(save).toHaveBeenCalledWith('p',{heightCm:170},{heightCm:{value:160,overridden:false}}));
});
it('keeps the pencil hidden for an old server and disables it for an unresolved person conflict',async()=>{
  const state={...performer().person,stashdbProfile:null,profileOverrides:{},profileFieldsSupported:false};
  const api=gateway({getPersonProfileState:vi.fn().mockResolvedValue(state),setPersonProfileFields:vi.fn()});
  const view=render(page(api));await screen.findByRole('heading',{name:'배우'});expect(screen.queryByRole('button',{name:'프로필 편집'})).toBeNull();view.unmount();
  render(page(gateway({getPersonProfileState:vi.fn().mockResolvedValue({...state,profileFieldsSupported:true,profileConflicts:[{operationId:'op',code:'revisionConflict'}]}),setPersonProfileFields:vi.fn()})));
  expect(await screen.findByRole('button',{name:'프로필 편집'})).toBeDisabled();expect(screen.getByRole('button',{name:'덮어쓰기'})).toBeVisible();
});

it('keeps the same profile rows when the async editor metadata arrives',async()=>{
 let finish:(value:PersonProfileState)=>void=()=>{};
 const links=[{url:'https://x.com/performer',site:{name:'X'}}];
 const api=gateway({getPerformerProfile:vi.fn().mockResolvedValue({...profile,urls:links}),getPersonProfileState:vi.fn(()=>new Promise<PersonProfileState>(resolve=>{finish=resolve;})),setPersonProfileFields:vi.fn()});
 render(page(api));await screen.findByText('158 cm');
 const original=document.querySelector('.av-profile__rows'),originalLinks=screen.getByLabelText('배우 링크');expect(original).not.toBeNull();
 await act(async()=>finish({...performer().person,profile:{heightCm:158,birthDate:profile.birthDate,careerStart:2024,urls:links.map(link=>({site:link.site.name,url:link.url}))},stashdbProfile:{heightCm:158},profileOverrides:{},profileFieldsSupported:true}));
 expect(document.querySelector('.av-profile__rows')).toBe(original);expect(document.querySelectorAll('.av-profile__rows')).toHaveLength(1);expect(screen.getByLabelText('배우 링크')).toBe(originalLinks);
});
it('sends the editor opening tokens after a profile change notification',async()=>{
 let changed=()=>{};
 const initial={...performer().person,profile:{heightCm:160},stashdbProfile:{heightCm:160},profileOverrides:{},profileFieldsSupported:true};
 const read=vi.fn().mockResolvedValue(initial),save=vi.fn().mockResolvedValue(initial);
 const api=gateway({getPersonProfileState:read,setPersonProfileFields:save,subscribeProfilesChanged:handler=>{changed=handler;return()=>{};}});
 render(page(api));fireEvent.click(await screen.findByRole('button',{name:'프로필 편집'}));fireEvent.change(screen.getByLabelText('키 (cm)'),{target:{value:'170'}});
 read.mockResolvedValue({...initial,profile:{heightCm:180},profileOverrides:{heightCm:180}});await act(async()=>changed());
 await screen.findByText(/다른 기기에서 바뀌었어요/);fireEvent.click(screen.getByRole('button',{name:'저장'}));
 await waitFor(()=>expect(save).toHaveBeenCalledWith('p',{heightCm:170},{heightCm:{value:160,overridden:false}}));
});
