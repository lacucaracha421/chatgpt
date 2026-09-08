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
async function mount() {
  const api=createCharacterFixture(), targets=await api.targets();
  const browse=vi.fn().mockResolvedValue({ items:fixtureAssets.slice(5),nextCursor:null,totalCount:13 });
  const hubApi={browse,saveSeries:vi.fn(),series:vi.fn()} as CharacterHubApi;
  const navigate=vi.fn(),changed=vi.fn();
  const gateway={listAssets:vi.fn().mockResolvedValue({items:fixtureAssets,nextCursor:null}),openLibrary:vi.fn()} as unknown as LibraryGateway;
  render(<LibraryProvider gateway={gateway}><SeriesBrowser series={{classificationId:"series",heroAssetId:null,autoClassify:true}} targets={targets} classifications={fixtureClassifications} privacyMode={false} metadataVisible thumbnailRowHeight={180} refreshVersion={0} onNavigate={navigate} onChanged={changed} api={api} hubApi={hubApi} /></LibraryProvider>);
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
  await waitFor(()=>expect(browse).toHaveBeenCalledWith(expect.objectContaining({seriesId:"series",referenceTargetId:"hina",targetId:null,all:true})));
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
