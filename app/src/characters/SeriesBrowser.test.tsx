import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { SeriesBrowser } from "./SeriesBrowser";
import { createCharacterFixture, fixtureAssets, fixtureClassifications } from "./characterFixtures";
import { LibraryProvider } from "../library/LibraryContext";
import type { LibraryGateway } from "../library/types";
import { characterHubApi, type CharacterHubApi } from "./hubApi";

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
it("opens editable information independently and keeps the nested reference picker usable",async()=>{
  const referenceBrowse=vi.spyOn(characterHubApi,"browse").mockResolvedValue({items:fixtureAssets,nextCursor:null,totalCount:fixtureAssets.length});
  const {api,navigate}=await mount(); const save=vi.spyOn(api,"save"); const user=userEvent.setup();
  await user.click(screen.getByRole("button",{name:"히나 정보"}));
  const panel=await screen.findByRole("dialog",{name:"히나 · 캐릭터 정보"});
  await user.type(within(panel).getByLabelText("설명"),"기준 설명");
  await user.click(within(panel).getByRole("button",{name:"설정 저장"}));
  await waitFor(()=>expect(save).toHaveBeenCalledWith(expect.objectContaining({description:"기준 설명"})));
  expect(navigate).not.toHaveBeenCalled();
  await user.click(within(panel).getByRole("button",{name:"기준 이미지 선택"}));
  const picker=await screen.findByRole("dialog",{name:"히나 · 기준 이미지"});
  await waitFor(()=>expect(referenceBrowse).toHaveBeenCalledWith(expect.objectContaining({seriesId:"series",referenceTargetId:"hina",targetId:null})));
  await user.click(within(picker).getByRole("button",{name:"기준 이미지 1 해제"}));
  expect(picker).toBeInTheDocument();
  await user.click(within(picker).getByRole("button",{name:"닫기"}));
  expect(panel).toBeInTheDocument();
});
