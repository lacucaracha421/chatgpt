import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { SeriesBrowser } from "./SeriesBrowser";
import { createCharacterFixture, fixtureAssets, fixtureClassifications } from "./characterFixtures";
import { LibraryProvider } from "../library/LibraryContext";
import type { LibraryGateway } from "../library/types";
import { type CharacterGroup, type CharacterHubApi } from "./hubApi";

beforeEach(() => { Object.defineProperties(HTMLElement.prototype, { clientWidth: { configurable:true,get:()=>850 },clientHeight:{configurable:true,get:()=>650} }); });
afterEach(() => { cleanup(); vi.restoreAllMocks(); });
async function mount(targetId?: string, pendingOnly = false, groups: CharacterGroup[] = [], groupId?: string) {
  const api=createCharacterFixture(), targets=await api.targets();
  if (pendingOnly) { api.reviewPending = vi.fn(async () => true); vi.spyOn(api, "review"); }
  const browse=vi.fn().mockResolvedValue({ items:fixtureAssets.slice(5),nextCursor:null,totalCount:13 });
  const hubApi={browse,saveSeries:vi.fn(),series:vi.fn(),createManualCharacter:vi.fn(),setSeriesAssetExcluded:vi.fn(),excludedAssets:vi.fn().mockResolvedValue({items:[],nextCursor:null,totalCount:0})} as CharacterHubApi;
  const navigate=vi.fn(),changed=vi.fn();
  const gateway={listAssets:vi.fn().mockResolvedValue({items:fixtureAssets,nextCursor:null}),openLibrary:vi.fn()} as unknown as LibraryGateway;
  render(<LibraryProvider gateway={gateway}><SeriesBrowser targetId={targetId} groupId={groupId} series={{classificationId:"series",heroAssetId:null,autoClassify:true}} targets={targets} groups={groups} classifications={fixtureClassifications} privacyMode={false} metadataVisible thumbnailRowHeight={180} refreshVersion={0} onNavigate={navigate} onChanged={changed} api={api} hubApi={hubApi} /></LibraryProvider>);
  return {api,browse,navigate,changed,hubApi};
}
it("opens a character relation from its card without changing classifications",async()=>{
  const {navigate,browse}=await mount(); const user=userEvent.setup();
  await user.click(await screen.findByRole("button",{name:"히나 열기"}));
  expect(navigate).toHaveBeenCalledWith({kind:"classification",classificationId:"series",characterId:"hina"});
  expect(browse).toHaveBeenCalledWith(expect.objectContaining({targetId:null,all:false}));
});
it("shows a mosaic group card and opens the group asset union",async()=>{
  const groups: CharacterGroup[]=[{id:"duo",seriesId:"series",name:"선도부",revision:1,targetIds:["hina","kisaki"]}];
  const {navigate}=await mount(undefined,false,groups); const user=userEvent.setup();
  const card=await screen.findByRole("button",{name:"선도부 그룹 열기"});
  expect(card.querySelector(".character-group-card__mosaic")).toHaveAttribute("data-count","2");
  expect(screen.queryByRole("button",{name:"히나 열기"})).not.toBeInTheDocument();
  expect(screen.queryByRole("button",{name:"키사키 열기"})).not.toBeInTheDocument();
  await user.click(card);
  expect(navigate).toHaveBeenCalledWith({kind:"classification",classificationId:"series",characterGroupId:"duo"});

  cleanup();
  const mounted=await mount(undefined,false,groups,"duo");
  await screen.findByRole("heading",{name:"그룹 · 선도부"});
  expect(screen.getByRole("button",{name:"히나 열기"})).toBeVisible();
  expect(screen.getByRole("button",{name:"키사키 열기"})).toBeVisible();
  await waitFor(()=>expect(mounted.browse).toHaveBeenCalledWith(expect.objectContaining({seriesId:"series",targetId:null,groupId:"duo"})));
  expect(screen.getByRole("heading",{name:/선도부 이미지/})).toBeVisible();
});

it("selects in the existing gallery and preserves the editor draft",async()=>{
  const {api,browse,navigate}=await mount(); const save=vi.spyOn(api,"save"); const user=userEvent.setup();
  await user.click(await screen.findByRole("button",{name:"히나 정보"}));
  let panel=await screen.findByRole("dialog",{name:"히나 · 캐릭터 정보"});
  await user.type(within(panel).getByLabelText("설명"),"기준 설명");
  await user.click(within(panel).getByRole("button",{name:"선택"}));
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  await waitFor(()=>expect(browse).toHaveBeenCalledWith(expect.objectContaining({seriesId:"series",referenceTargetId:"hina",targetId:"hina",all:true})));
  await user.click(screen.getByRole("button",{name:"선택 이미지 1 해제"}));
  await user.click(await screen.findByRole("option",{name:"이미지 5.webp"}));
  await user.click(screen.getByRole("button",{name:"완료"}));
  panel=await screen.findByRole("dialog",{name:"히나 · 캐릭터 정보"});
  expect(within(panel).getByLabelText("설명")).toHaveValue("기준 설명");
  await user.click(within(panel).getByRole("button",{name:"저장"}));
  await waitFor(()=>expect(save).toHaveBeenCalledWith(expect.objectContaining({description:"기준 설명"}),true));
  expect(navigate).not.toHaveBeenCalled();
});
it("filters a new character's selection even when all is requested",async()=>{
  const {browse}=await mount(); const user=userEvent.setup();
  await user.click(await screen.findByRole("button",{name:"캐릭터 등록"}));
  let panel=await screen.findByRole("dialog",{name:"새 캐릭터"});
  await user.type(within(panel).getByLabelText("캐릭터 이름"),"아루");
  await user.click(within(panel).getByRole("button",{name:"대표 이미지 선택"}));
  await waitFor(()=>expect(browse).toHaveBeenCalledWith(expect.objectContaining({referenceTargetId:"",all:false})));
  await user.click(screen.getByRole("button",{name:"전체 보기"}));
  await waitFor(()=>expect(browse).toHaveBeenCalledWith(expect.objectContaining({referenceTargetId:"",all:true})));
  await user.click(screen.getByRole("button",{name:"취소"}));
  panel=await screen.findByRole("dialog",{name:"새 캐릭터"});
  expect(within(panel).getByLabelText("캐릭터 이름")).toHaveValue("아루");
});


it("reuses one candidate snapshot for thumbnail and reference picking",async()=>{
  const {browse}=await mount(); const user=userEvent.setup();
  await user.click(await screen.findByRole("button",{name:"캐릭터 등록"}));
  let panel=await screen.findByRole("dialog",{name:"새 캐릭터"});
  await user.type(within(panel).getByLabelText("캐릭터 이름"),"아루");
  await user.click(within(panel).getByRole("button",{name:"대표 이미지 선택"}));
  await waitFor(()=>expect(browse).toHaveBeenCalledWith(expect.objectContaining({referenceTargetId:"",targetId:null,all:false})));
  const candidateCalls=()=>browse.mock.calls.filter(([query])=>query.referenceTargetId==="" && query.all===false).length;
  expect(candidateCalls()).toBe(1);
  await user.click(await screen.findByRole("option",{name:"이미지 5.webp"}));
  await user.click(screen.getByRole("button",{name:"완료"}));
  panel=await screen.findByRole("dialog",{name:"새 캐릭터"});
  await user.click(within(panel).getByRole("button",{name:"선택"}));
  await screen.findByRole("option",{name:"이미지 5.webp"});
  expect(candidateCalls()).toBe(1);
});

it("creates a manual character or explicitly ends character classification",async()=>{
  const first=await mount(); const user=userEvent.setup();
  const manual={...(await first.api.targets())[0],id:"manual",displayName:"단역",manualOnly:true,ready:false,references:[]};
  vi.mocked(first.hubApi.createManualCharacter).mockResolvedValue(manual);
  await user.click(await screen.findByRole("option",{name:"이미지 5.webp"}));
  const actions=screen.getByRole("region",{name:"선택 이미지 캐릭터 지정"});
  await user.click(within(actions).getByRole("button",{name:"새 수동 캐릭터"}));
  const dialog=screen.getByRole("dialog",{name:"새 수동 캐릭터"});
  await user.type(within(dialog).getByRole("textbox",{name:"캐릭터 이름"}),"단역");
  await user.click(within(dialog).getByRole("button",{name:"수동 캐릭터 만들기"}));
  await waitFor(()=>expect(first.hubApi.createManualCharacter).toHaveBeenCalledWith({seriesId:"series",displayName:"단역",assetIds:["image-5"]}));
  expect(first.navigate).toHaveBeenCalledWith({kind:"classification",classificationId:"series",characterId:"manual"});

  cleanup();
  const second=await mount();
  await userEvent.setup().click(await screen.findByRole("option",{name:"이미지 5.webp"}));
  await userEvent.setup().click(screen.getByRole("button",{name:"캐릭터 분류 제외"}));
  await waitFor(()=>expect(second.hubApi.setSeriesAssetExcluded).toHaveBeenCalledWith({seriesId:"series",assetIds:["image-5"],excluded:true}));
  await userEvent.setup().click(screen.getByRole("button",{name:"분류 제외 보기"}));
  await waitFor(()=>expect(second.hubApi.excludedAssets).toHaveBeenCalledWith("series",null,100));
});

it("keeps character selection in the header and shows pending review",async()=>{
  const {api}=await mount("hina"); const user=userEvent.setup();
  const decide=vi.spyOn(api,"decide");
  await screen.findByRole("button",{name:"검토 · 검토 대기 있음"});
  expect(screen.queryByText("0장 선택")).not.toBeInTheDocument();
  await user.click(await screen.findByRole("option",{name:"이미지 5.webp"}));
  expect(screen.getAllByText("1장 선택")).toHaveLength(1);
  expect(within(screen.getByRole("toolbar",{name:"시리즈 도구"})).getByText("1장 선택")).toBeInTheDocument();
  expect(document.querySelector(".series-gallery .series-selection")).toBeNull();
  await user.click(screen.getByRole("button",{name:"캐릭터에서 제외"}));
  await waitFor(()=>expect(decide).toHaveBeenCalledWith(expect.objectContaining({targetId:"hina",assetIds:["image-5"],decision:"rejected"})));
  expect(screen.queryByText("1장 선택")).not.toBeInTheDocument();
});


it("assigns multiple checked characters in one batch and clears only on success", async () => {
  const { api } = await mount();
  const user = userEvent.setup();
  const batch = vi.spyOn(api, "decideBatch").mockRejectedValueOnce(new Error("저장 실패"));
  await user.click(await screen.findByRole("option", { name: "이미지 5.webp" }));
  const panel = screen.getByRole("region", { name: "선택 이미지 캐릭터 지정" });
  await user.click(within(panel).getByRole("checkbox", { name: "히나" }));
  await user.click(within(panel).getByRole("checkbox", { name: "키사키" }));
  await user.click(within(panel).getByRole("button", { name: "지정 · 2명" }));
  await screen.findByText("저장 실패");
  expect(within(panel).getByRole("checkbox", { name: "히나" })).toBeChecked();
  expect(within(panel).getByText("1장 선택")).toBeInTheDocument();
  batch.mockResolvedValueOnce(2);
  await user.click(within(panel).getByRole("button", { name: "지정 · 2명" }));
  await waitFor(() => expect(screen.queryByRole("region", { name: "선택 이미지 캐릭터 지정" })).not.toBeInTheDocument());
  expect(batch).toHaveBeenLastCalledWith([
    expect.objectContaining({ targetId: "hina", assetIds: ["image-5"], decision: "accepted" }),
    expect.objectContaining({ targetId: "kisaki", assetIds: ["image-5"], decision: "accepted" }),
  ]);
});

it("limits an existing character portrait picker to its own folder", async () => {
  const { browse } = await mount("hina");
  const user = userEvent.setup();
  await user.click(await screen.findByRole("button", { name: "캐릭터 더보기" }));
  const panel = await screen.findByRole("dialog", { name: "히나 · 캐릭터 정보" });
  await user.click(within(panel).getByRole("button", { name: "대표 이미지 선택" }));
  await waitFor(() => expect(browse).toHaveBeenCalledWith(expect.objectContaining({ targetId: "hina", referenceTargetId: "hina", all: true })));
  expect(screen.getByRole("heading", { name: /히나 캐릭터 폴더/ })).toBeVisible();
  expect(screen.queryByRole("button", { name: "미분류만 보기" })).not.toBeInTheDocument();
});

it("allows reference selection from the series after opening the character folder", async () => {
  const {browse}=await mount("hina"); const user=userEvent.setup();
  await user.click(await screen.findByRole("button",{name:"캐릭터 더보기"}));
  const panel=await screen.findByRole("dialog",{name:"히나 · 캐릭터 정보"});
  await user.click(within(panel).getByRole("button",{name:"대표 이미지 선택"}));
  await user.click(await screen.findByRole("button",{name:"시리즈에서 이미지 찾기"}));
  await waitFor(()=>expect(browse).toHaveBeenLastCalledWith(expect.objectContaining({targetId:null,referenceTargetId:"hina"})));
  const callsBeforeReturn=browse.mock.calls.length;
  await user.click(screen.getByRole("button",{name:"캐릭터 폴더로 돌아가기"}));
  await screen.findByRole("heading",{name:/히나 캐릭터 폴더/});
  expect(browse).toHaveBeenCalledTimes(callsBeforeReturn);
});

it("uses the lightweight pending lookup without loading review evidence for the badge", async () => {
  const { api } = await mount("hina", true);
  await screen.findByRole("button", { name: "검토 · 검토 대기 있음" });
  expect(api.reviewPending).toHaveBeenCalledWith("series", "hina");
  expect(api.review).not.toHaveBeenCalled();
});
