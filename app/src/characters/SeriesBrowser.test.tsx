import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { SeriesBrowser } from "./SeriesBrowser";
import { createCharacterFixture, fixtureAssets, fixtureClassifications } from "./characterFixtures";
import { LibraryProvider } from "../library/LibraryContext";
import type { LibraryGateway } from "../library/types";
import { type CharacterHubApi } from "./hubApi";

beforeEach(() => { Object.defineProperties(HTMLElement.prototype, { clientWidth: { configurable:true,get:()=>850 },clientHeight:{configurable:true,get:()=>650} }); });
afterEach(() => { cleanup(); vi.restoreAllMocks(); });
async function mount(targetId?: string) {
  const api=createCharacterFixture(), targets=await api.targets();
  const browse=vi.fn().mockResolvedValue({ items:fixtureAssets.slice(5),nextCursor:null,totalCount:13 });
  const hubApi={browse,saveSeries:vi.fn(),series:vi.fn()} as CharacterHubApi;
  const navigate=vi.fn(),changed=vi.fn();
  const gateway={listAssets:vi.fn().mockResolvedValue({items:fixtureAssets,nextCursor:null}),openLibrary:vi.fn()} as unknown as LibraryGateway;
  render(<LibraryProvider gateway={gateway}><SeriesBrowser targetId={targetId} series={{classificationId:"series",heroAssetId:null,autoClassify:true}} targets={targets} classifications={fixtureClassifications} privacyMode={false} metadataVisible thumbnailRowHeight={180} refreshVersion={0} onNavigate={navigate} onChanged={changed} api={api} hubApi={hubApi} /></LibraryProvider>);
  return {api,browse,navigate,changed};
}
it("opens a character relation from its card without changing classifications",async()=>{
  const {navigate,browse}=await mount(); const user=userEvent.setup();
  await user.click(await screen.findByRole("button",{name:"히나 열기"}));
  expect(navigate).toHaveBeenCalledWith({kind:"classification",classificationId:"series",characterId:"hina"});
  expect(browse).toHaveBeenCalledWith(expect.objectContaining({targetId:null,all:false}));
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
  await user.click(screen.getByRole("button",{name:"캐릭터 폴더로 돌아가기"}));
  await waitFor(()=>expect(browse).toHaveBeenLastCalledWith(expect.objectContaining({targetId:"hina",referenceTargetId:"hina"})));
});
