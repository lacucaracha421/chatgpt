import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { SeriesBrowser } from "./SeriesBrowser";
import { draftReferenceRegions, type ReferenceRegion, type CharacterTarget } from "./api";
import { createCharacterFixture, fixtureAssets, fixtureClassifications } from "./characterFixtures";
import { LibraryProvider } from "../library/LibraryContext";
import type { LibraryGateway } from "../library/types";
import { type CharacterGroup, type CharacterHubApi, type SeriesFolder } from "./hubApi";
import { ChromeSettingsDock, WorkspaceChromeProvider } from "../layout/WorkspaceChrome";
import { emptyShadowSummary, type ShadowReviewApi } from "./shadowReviewApi";
import { s36PublicationApi } from "./S36Publication";
import { FaultGameProvider } from "../games/FaultGame";
import { PrivacyProvider } from "../privacy/PrivacyContext";

async function openReferencePicker(user: ReturnType<typeof userEvent.setup>) {
  await user.click(await screen.findByRole("button", { name: "캐릭터 더보기" }));
  const panel = await screen.findByRole("dialog", { name: "히나 · 캐릭터 정보" });
  await user.click(within(panel).getByRole("button", { name: "레퍼런스 추가" }));
}

beforeEach(() => { Object.defineProperties(HTMLElement.prototype, { clientWidth: { configurable:true,get:()=>850 },clientHeight:{configurable:true,get:()=>650} }); });
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

it("can select and save a sixth reference without a separate additional-reference workflow", async () => {
  const { api } = await mount("hina");
  const save = vi.spyOn(api, "saveSettings");
  const user = userEvent.setup();
  await user.click(await screen.findByRole("button", { name: "캐릭터 더보기" }));
  let panel = await screen.findByRole("dialog", { name: "히나 · 캐릭터 정보" });
  await user.click(within(panel).getByRole("button", { name: "레퍼런스 추가" }));
  await user.click(await screen.findByRole("option", { name: "이미지 5.webp" }));
  await user.click(screen.getByRole("button", { name: "완료" }));
  panel = await screen.findByRole("dialog", { name: "히나 · 캐릭터 정보" });
  await user.click(within(panel).getByRole("button", { name: "저장" }));
  await waitFor(() => expect(save).toHaveBeenCalledWith(expect.objectContaining({ referenceIds: fixtureAssets.slice(0, 6).map(asset => asset.id) }), true));
});
it("blocks a missing original before reference inspection while allowing an available addition", async () => {
  const { api, browse } = await mount("hina");
  const save = vi.spyOn(api, "saveSettings");
  browse.mockResolvedValue({ items: fixtureAssets.slice(5), nextCursor: null, totalCount: 13,
    unavailableReferenceIds: [fixtureAssets[5].id] });
  const user = userEvent.setup();
  await openReferencePicker(user);
  const missing = await screen.findByRole("option", { name: "이미지 5.webp" });
  await user.click(missing);
  expect(missing).toHaveAttribute("aria-selected", "false");
  expect(screen.getByRole("alert")).toHaveTextContent("이미지 5.webp");
  expect(screen.getByRole("alert")).toHaveTextContent("원본 파일이 없어");
  missing.focus();
  await user.keyboard("{Enter}");
  expect(missing).toHaveAttribute("aria-selected", "false");
  await user.click(screen.getByRole("option", { name: "이미지 6.webp" }));
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "완료" }));
  const panel = await screen.findByRole("dialog", { name: "히나 · 캐릭터 정보" });
  await user.click(within(panel).getByRole("button", { name: "저장" }));
  await waitFor(() => expect(save).toHaveBeenCalledWith(expect.objectContaining({
    referenceIds: [...fixtureAssets.slice(0, 5).map(asset => asset.id), fixtureAssets[6].id],
  }), true));
});

it("keeps missing-original status across picker pages and refreshes it on retry", async () => {
  const { browse } = await mount("hina");
  browse.mockImplementation(async query => query.after
    ? { items: [fixtureAssets[6]], nextCursor: null, totalCount: 2 }
    : { items: [fixtureAssets[5]], nextCursor: "next", totalCount: 2,
      unavailableReferenceIds: [fixtureAssets[5].id] });
  const user = userEvent.setup();
  await openReferencePicker(user);
  await screen.findByRole("option", { name: "이미지 6.webp" });
  const missing = screen.getByRole("option", { name: "이미지 5.webp" });
  await user.click(missing);
  expect(missing).toHaveAttribute("aria-selected", "false");
  expect(screen.getByRole("alert")).toHaveTextContent("원본 파일이 없어");

  browse.mockResolvedValue({ items: fixtureAssets.slice(5, 7), nextCursor: null, totalCount: 2 });
  const calls = browse.mock.calls.length;
  await user.click(within(screen.getByRole("alert")).getByRole("button", { name: "다시 시도" }));
  await waitFor(() => expect(browse.mock.calls.length).toBeGreaterThan(calls));
  await waitFor(() => expect(screen.queryByText("원본이 없는 이미지는 선택할 수 없습니다. 썸네일은 남아 있을 수 있습니다.")).not.toBeInTheDocument());
  await user.click(screen.getByRole("option", { name: "이미지 5.webp" }));
  expect(screen.getByRole("option", { name: "이미지 5.webp" })).toHaveAttribute("aria-selected", "true");
});

async function mount(targetId?: string, pendingOnly = false, groups: CharacterGroup[] = [], groupId?: string, withChrome = false, legacy?: { targetOverrides?: Partial<CharacterTarget>; seriesAutoClassify?: boolean; excludedCount?: number; targetEnabled?: boolean; folders?: SeriesFolder[]; exclusions?: string[]; privacyMode?: boolean; sourceUrl?: string; candidates?: number; shadowItems?: string[]; fault?: boolean; inspect?: (seriesId: string, targetId: string | null, assetIds: string[], regions?: Record<string, unknown>) => Promise<unknown[]> }) {
  const api=createCharacterFixture(), sourceTargets=await api.targets();
  const targets = sourceTargets.map(target => target.id === (targetId ?? "hina") ? {
    ...target,
    ...(legacy?.targetEnabled === undefined ? {} : { enabled: legacy.targetEnabled, ready: legacy.targetEnabled && target.ready }),
    ...legacy?.targetOverrides,
  } : target);
  if (legacy?.inspect) api.inspectReferenceRegions = vi.fn(legacy.inspect) as unknown as typeof api.inspectReferenceRegions;
  if (pendingOnly) { api.reviewPending = vi.fn(async () => true); vi.spyOn(api, "review"); }
  const browse=vi.fn().mockResolvedValue({ items:fixtureAssets.slice(5).map(asset => ({ ...asset, sourceUrl: legacy?.sourceUrl ?? asset.sourceUrl })),nextCursor:null,totalCount:13 });
  const hubApi={folderExclusions:vi.fn().mockResolvedValue([]),seriesFolders:vi.fn().mockResolvedValue(legacy?.folders ?? []),setFolderExcluded:vi.fn().mockResolvedValue(undefined),browse,saveSeries:vi.fn(),series:vi.fn(),createManualCharacter:vi.fn(),completeReview:vi.fn().mockResolvedValue(1),setSeriesAssetExcluded:vi.fn(),excludedAssets:vi.fn().mockResolvedValue({items:[],nextCursor:null,totalCount:legacy?.excludedCount ?? 0}),
    referenceCandidates:vi.fn(async(targetId:string)=>{ const target=targets.find(item=>item.id===targetId)!; return {targetId,targetRevision:target.revision,referenceSetHash:`set-${targetId}`,confirmationMode:target.manualOnly?"initialize":"add_learned",minimumSelection:target.manualOnly?5:1,items:fixtureAssets.slice(5,7),suggestedAssetIds:fixtureAssets.slice(5,7).map(item=>item.id)}; }),
    confirmReferenceBatch:vi.fn(async()=>targets[0]),
    requestReferenceRefresh:vi.fn(async(targetId:string)=>({targetId,requestRevision:1,state:"pending" as const,eligibleCount:12})),
  } as CharacterHubApi;
  const shadowApi={page:vi.fn(async()=>({items:(legacy?.shadowItems ?? []).map(assetId=>({assetId,contentHash:assetId,originalName:`${assetId}.png`,width:10,height:10,targetId:"hina",targetName:"히나",targetFingerprint:"fp",referenceAssetIds:[],verdict:"automatic",origin:"live",knn3:null,nativeOutcome:"none",scoredAt:"2026-09-24T00:00:00Z"})),nextOffset:null,policyVersion:null,summary:{...emptyShadowSummary(),automatic:{pending:legacy?.candidates ?? 0,accepted:0,rejected:0}}})),
    start:vi.fn(),cancel:vi.fn(),status:vi.fn().mockResolvedValue({running:false,preparing:false,total:0,scored:0,skipped:0,cancelled:false,error:null})} as unknown as ShadowReviewApi;
  const navigate=vi.fn(),changed=vi.fn();
  const onGalleryLayoutChange=vi.fn(),onMetadataVisibleChange=vi.fn(),onPrivacyModeChange=vi.fn(),onThumbnailRowHeightChange=vi.fn();
  const gateway={listAssets:vi.fn().mockResolvedValue({items:fixtureAssets,nextCursor:null}),openLibrary:vi.fn()} as unknown as LibraryGateway;
  const browser=<SeriesBrowser folderExclusions={legacy?.exclusions ?? []} targetId={targetId} groupId={groupId} series={{classificationId:"series",heroAssetId:null,autoClassify:legacy?.seriesAutoClassify ?? true}} targets={targets} groups={groups} classifications={[...fixtureClassifications, {id:"machines",name:"기체",kind:"tag",parentId:"series",iconKey:null,colorKey:null}]} galleryLayout="masonry" onGalleryLayoutChange={onGalleryLayoutChange} privacyMode={legacy?.privacyMode ?? false} onPrivacyModeChange={onPrivacyModeChange} metadataVisible onMetadataVisibleChange={onMetadataVisibleChange} thumbnailRowHeight={180} onThumbnailRowHeightChange={onThumbnailRowHeightChange} refreshVersion={0} onNavigate={navigate} onChanged={changed} api={api} hubApi={hubApi} shadowApi={shadowApi} />;
  const content = withChrome ? <WorkspaceChromeProvider scope="series"><div className="workspace-navigation"><aside className="workspace-index"><ChromeSettingsDock /></aside>{browser}</div></WorkspaceChromeProvider> : browser;
  render(<LibraryProvider gateway={gateway}>{legacy?.fault ? <PrivacyProvider privacyMode={false} setPrivacyMode={() => undefined}><FaultGameProvider>{content}</FaultGameProvider></PrivacyProvider> : content}</LibraryProvider>);
  return {api,browse,shadowApi,navigate,changed,hubApi,onGalleryLayoutChange,onMetadataVisibleChange,onPrivacyModeChange,onThumbnailRowHeightChange};
}

it("provides working display settings inside character folders", async () => {
  const callbacks=await mount("hina",false,[],undefined,true); const user=userEvent.setup();
  const trigger=await screen.findByRole("button",{name:"보기 설정"});
  expect(trigger).toBeEnabled();
  await user.click(trigger);
  const panel=screen.getByRole("dialog",{name:"보기 설정"});
  await user.selectOptions(within(panel).getByLabelText("배치"),"justified");
  await user.click(within(panel).getByRole("checkbox",{name:"정보 숨기기"}));
  await user.click(within(panel).getByRole("checkbox",{name:"비공개 모드"}));
  expect(callbacks.onGalleryLayoutChange).toHaveBeenCalledWith("justified");
  expect(callbacks.onMetadataVisibleChange).toHaveBeenCalledWith(false);
  expect(callbacks.onPrivacyModeChange).toHaveBeenCalledWith(true);
});
it("opens a character relation from its card without changing classifications",async()=>{
  const {navigate,browse}=await mount(); const user=userEvent.setup();
  await user.click(await screen.findByRole("button",{name:"히나 열기"}));
  expect(navigate).toHaveBeenCalledWith({kind:"classification",classificationId:"series",characterId:"hina"});
  expect(browse).toHaveBeenCalledWith(expect.objectContaining({targetId:null,all:false}));
});
it("keeps normal series browsing free of review and exclusion work", async () => {
  await mount();
  const filters = await screen.findByRole("radiogroup", { name: "시리즈 이미지 필터" });
  expect(filters.parentElement).toHaveTextContent("13장");
  expect(within(filters).getByRole("radio", { name: "미분류" })).toBeInTheDocument();
  expect(within(filters).getByRole("radio", { name: "전체 이미지" })).toBeInTheDocument();
  expect(within(filters).queryByRole("radio", { name: "추가 확인" })).not.toBeInTheDocument();
  expect(within(filters).queryByRole("radio", { name: "자동 분류 제외" })).not.toBeInTheDocument();
  await userEvent.setup().click(await screen.findByRole("option", { name: "이미지 5.webp" }));
  const actions = screen.getByRole("region", { name: "선택 이미지 캐릭터 지정" });
  expect(within(actions).queryByRole("button", { name: "확인 완료" })).not.toBeInTheDocument();
  expect(within(actions).queryByRole("button", { name: "자동 분류에서 제외" })).not.toBeInTheDocument();
});

it("shows legacy series recovery only when legacy state exists", async () => {
  await mount(undefined, false, [], undefined, false, { seriesAutoClassify: false, excludedCount: 2 });
  expect(await screen.findByRole("button", { name: "자동 분류 다시 켜기" })).toBeInTheDocument();
  const filters = screen.getByRole("radiogroup", { name: "시리즈 이미지 필터" });
  expect(within(filters).getByRole("radio", { name: "자동 분류 제외" })).toBeInTheDocument();
});

it("does not poll or expose character review in normal character browsing", async () => {
  const { api } = await mount("hina", true);
  await screen.findByRole("toolbar", { name: "시리즈 도구" });
  expect(screen.queryByRole("button", { name: /검토/ })).not.toBeInTheDocument();
  expect(api.reviewPending).not.toHaveBeenCalled();
  expect(api.review).not.toHaveBeenCalled();
});

it("hides normal series automation controls", async () => {
  await mount("hina");
  expect(screen.queryByRole("button", { name: /자동 분류 설정/ })).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "자동 분류 다시 켜기" })).not.toBeInTheDocument();
});

it("shows a mosaic group card and opens the group asset union",async()=>{
  const groups: CharacterGroup[]=[{id:"duo",seriesId:"series",name:"선도부",revision:1,targetIds:["hina","kisaki"]}];
  const {navigate}=await mount(undefined,false,groups); const user=userEvent.setup();
  const card=await screen.findByRole("button",{name:"선도부 그룹 열기"});
  expect(card.querySelector(".character-group-card__mosaic")).toHaveAttribute("data-count","2");
  const groupIcon = card.querySelector(".character-group-card__icon");
  expect(groupIcon).not.toHaveClass("series-character__ready");
  expect(screen.queryByRole("button",{name:"히나 열기"})).not.toBeInTheDocument();
  expect(screen.queryByRole("button",{name:"키사키 열기"})).not.toBeInTheDocument();
  await user.click(card);
  expect(navigate).toHaveBeenCalledWith({kind:"classification",classificationId:"series",characterGroupId:"duo"});

  cleanup();
  const mounted=await mount(undefined,false,groups,"duo");
  expect(await screen.findByRole("button",{name:"히나 열기"})).toBeVisible();
  expect(screen.getByRole("button",{name:"키사키 열기"})).toBeVisible();
  await waitFor(()=>expect(mounted.browse).toHaveBeenCalledWith(expect.objectContaining({seriesId:"series",targetId:null,groupId:"duo"})));
  // No group heading, back button or "이미지" section line: the titlebar carries name, count and actions.
  expect(screen.queryByRole("heading",{name:/그룹 · 선도부|선도부 이미지/})).not.toBeInTheDocument();
  expect(screen.queryByRole("button",{name:"시리즈로"})).not.toBeInTheDocument();
  const more=within(screen.getByRole("toolbar",{name:"시리즈 도구"})).getByRole("button",{name:"그룹 더보기"});
  expect(more.querySelector("path")?.getAttribute("d")).not.toBe("M3 10h4v4H3zM10 10h4v4h-4zM17 10h4v4h-4z");
  await user.click(more);
  await user.click(await screen.findByRole("menuitem",{name:"그룹 편집"}));
  expect(await screen.findByRole("dialog",{name:"캐릭터 그룹 편집"})).toBeVisible();
});

it("selects in the existing gallery and preserves the editor draft",async()=>{
  const {api,browse,navigate}=await mount(); const saveSettings=vi.spyOn(api,"saveSettings"); const user=userEvent.setup();
  await user.click(await screen.findByRole("button",{name:"히나 편집"}));
  let panel=await screen.findByRole("dialog",{name:"히나 · 캐릭터 정보"});
  await user.click(within(panel).getByText("관리"));
  await user.type(within(panel).getByLabelText("설명"),"기준 설명");
  await user.click(within(panel).getByRole("button",{name:"레퍼런스 추가"}));
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  await waitFor(()=>expect(browse).toHaveBeenCalledWith(expect.objectContaining({seriesId:"series",referenceTargetId:"hina",targetId:"hina",all:true})));
  await user.click(screen.getByRole("button",{name:"선택 이미지 1 해제"}));
  await user.click(await screen.findByRole("option",{name:"이미지 5.webp"}));
  await user.click(screen.getByRole("button",{name:"완료"}));
  panel=await screen.findByRole("dialog",{name:"히나 · 캐릭터 정보"});
  expect(within(panel).getByLabelText("설명")).toHaveValue("기준 설명");
  await user.click(within(panel).getByRole("button",{name:"저장"}));
  await waitFor(()=>expect(saveSettings).toHaveBeenCalledWith(expect.objectContaining({description:"기준 설명",referenceIds:expect.any(Array)}),true));
  expect(navigate).not.toHaveBeenCalled();
});
it("filters a new character's selection even when all is requested",async()=>{
  const {browse}=await mount(); const user=userEvent.setup();
  await user.click(await screen.findByRole("button",{name:"캐릭터 만들기"}));
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
  await user.click(await screen.findByRole("button",{name:"캐릭터 만들기"}));
  let panel=await screen.findByRole("dialog",{name:"새 캐릭터"});
  await user.type(within(panel).getByLabelText("캐릭터 이름"),"아루");
  await user.click(within(panel).getByRole("button",{name:"대표 이미지 선택"}));
  await waitFor(()=>expect(browse).toHaveBeenCalledWith(expect.objectContaining({referenceTargetId:"",targetId:null,all:false})));
  const candidateCalls=()=>browse.mock.calls.filter(([query])=>query.referenceTargetId==="" && query.all===false).length;
  expect(candidateCalls()).toBe(1);
  await user.click(await screen.findByRole("option",{name:"이미지 5.webp"}));
  await user.click(screen.getByRole("button",{name:"완료"}));
  panel=await screen.findByRole("dialog",{name:"새 캐릭터"});
  await user.click(within(panel).getByRole("button",{name:"레퍼런스 추가"}));
  await screen.findByRole("option",{name:"이미지 5.webp"});
  expect(candidateCalls()).toBe(1);
});

it("keeps the series header to a quiet create icon and one overflow for cover and group setup",async()=>{
  await mount(undefined,false,[],undefined,true);
  const user=userEvent.setup();
  const toolbar=screen.getByRole("toolbar",{name:"시리즈 도구"});
  const create=within(toolbar).getByRole("button",{name:"캐릭터 만들기"});
  expect(create).toHaveTextContent("");
  expect(screen.queryByRole("button",{name:"그룹 만들기"})).not.toBeInTheDocument();
  expect(within(toolbar).queryByRole("button",{name:"새로고침"})).not.toBeInTheDocument();
  expect(within(toolbar).queryByRole("button",{name:"히어로 이미지 선택"})).not.toBeInTheDocument();
  expect(within(toolbar).queryByRole("button",{name:"자동 분류 다시 켜기"})).not.toBeInTheDocument();
  expect(within(toolbar).queryByRole("button",{name:/후보 확인/})).not.toBeInTheDocument();
  const more=within(toolbar).getByRole("button",{name:"시리즈 더보기"});
  more.focus();
  await user.keyboard("{Enter}");
  expect(await screen.findByRole("menuitem",{name:"시리즈 표지 선택"})).toBeVisible();
  await user.keyboard("{Escape}");
  await waitFor(()=>expect(more).toHaveFocus());
  await user.click(more);
  await user.click(screen.getByRole("menuitem",{name:"시리즈 표지 선택"}));
  expect(screen.getByRole("region",{name:"갤러리 이미지 선택"})).toBeVisible();
  await user.click(screen.getByRole("button",{name:"취소"}));
  await user.click(within(toolbar).getByRole("button",{name:"캐릭터 만들기"}));
  expect(await screen.findByRole("dialog",{name:"새 캐릭터"})).toBeVisible();
});

it("creates a group from the series overflow",async()=>{
  await mount();
  const user=userEvent.setup();
  await user.click(await screen.findByRole("button",{name:"시리즈 더보기"}));
  await user.click(await screen.findByRole("menuitem",{name:"그룹 만들기"}));
  expect(await screen.findByRole("dialog",{name:"캐릭터 그룹 만들기"})).toBeVisible();
});

it("shows compact name-only tiles with a warning mark only when S36 found mistakes",async()=>{
  vi.spyOn(s36PublicationApi, "get").mockResolvedValue({ series: [], excludedTargets: [], scoringEnabled: true });
  vi.spyOn(s36PublicationApi, "readiness").mockResolvedValue([{ targetId: "hina", reviewed: 30, wrong: 2, examples: 40, status: "hold" }]);
  await mount();
  const hina=await screen.findByRole("button",{name:"히나 열기"});
  await waitFor(()=>expect(hina.querySelector(".series-character__warning")).not.toBeNull());
  expect(hina).toHaveAttribute("aria-description", expect.stringContaining("S36 보류 · 확인 30 · 틀림 2"));
  expect(hina.querySelector("small")).toBeNull();
  expect(screen.queryByText(/S36 보류/)).not.toBeInTheDocument();
  const kisaki=screen.getByRole("button",{name:"키사키 열기"});
  expect(kisaki.querySelector(".series-character__warning")).toBeNull();

  cleanup();
  await mount("hina");
  expect(await screen.findByText("S36 보류 · 확인 30 · 틀림 2", { exact: false })).toHaveClass("series-character-status--warning");
});

it("keeps character selection in place without a persistent refresh button",async()=>{
  await mount("hina");
  const user=userEvent.setup();
  const toolbar=screen.getByRole("toolbar",{name:"시리즈 도구"});
  expect(within(toolbar).queryByRole("button",{name:"레퍼런스 추가"})).not.toBeInTheDocument();
  expect(within(toolbar).getByRole("button",{name:"캐릭터 더보기"})).toBeVisible();
  expect(within(toolbar).queryByRole("button",{name:"새로고침"})).not.toBeInTheDocument();
  await user.click(await screen.findByRole("option",{name:"이미지 5.webp"}));
  await user.click(within(toolbar).getByRole("button",{name:"캐릭터 더보기"}));
  await screen.findByRole("dialog",{name:"히나 · 캐릭터 정보"});
  await user.keyboard("{Escape}");
  expect(screen.getByRole("option",{name:"이미지 5.webp"})).toHaveAttribute("aria-selected","true");
  expect(within(toolbar).getByRole("button",{name:"이 캐릭터에서 제외"})).toBeVisible();
});

it("keeps manual refresh available from the gallery context menu",async()=>{
  const {browse,changed}=await mount();
  const user=userEvent.setup();
  const item=await screen.findByRole("option",{name:"이미지 5.webp"});
  const calls=browse.mock.calls.length;
  await user.pointer({target:item,keys:"[MouseRight]"});
  for (const name of ["좋아요 켜기", "좋아요 끄기", "폴더로 이동", "불러온 이미지 선택", "선택 해제"]) {
    expect(screen.queryByRole("menuitem", { name })).not.toBeInTheDocument();
  }
  await user.click(await screen.findByRole("menuitem",{name:"새로고침"}));
  await waitFor(()=>expect(browse.mock.calls.length).toBeGreaterThan(calls));
  expect(changed).toHaveBeenCalled();
});

it("creates an underfilled character as manual management",async()=>{
  const first=await mount(); const user=userEvent.setup();
  const manual={...(await first.api.targets())[0],id:"manual",displayName:"단역",manualOnly:true,ready:false,references:[]};
  vi.mocked(first.hubApi.createManualCharacter).mockResolvedValue(manual);
  await user.click(await screen.findByRole("option",{name:"이미지 5.webp"}));
  const actions=screen.getByRole("region",{name:"선택 이미지 캐릭터 지정"});
  await user.click(within(actions).getByRole("button",{name:"새 캐릭터"}));
  const dialog=screen.getByRole("dialog",{name:"새 캐릭터"});
  expect(within(dialog).getByText(/수동 관리로 시작/)).toBeVisible();
  await user.type(within(dialog).getByRole("textbox",{name:"캐릭터 이름"}),"단역");
  await user.click(within(dialog).getByRole("button",{name:"캐릭터 만들기"}));
  await waitFor(()=>expect(first.hubApi.createManualCharacter).toHaveBeenCalledWith({seriesId:"series",displayName:"단역",assetIds:["image-5"]}));
  expect(first.navigate).toHaveBeenCalledWith({kind:"classification",classificationId:"series",characterId:"manual"});
});

it("keeps character selection in the header without review status",async()=>{
  const {api}=await mount("hina"); const user=userEvent.setup();
  const decide=vi.spyOn(api,"decide");
  expect(screen.queryByRole("button",{name:/검토/})).not.toBeInTheDocument();
  expect(screen.queryByText("0장 선택")).not.toBeInTheDocument();
  await user.click(await screen.findByRole("option",{name:"이미지 5.webp"}));
  expect(screen.getAllByText("1장 선택")).toHaveLength(1);
  expect(within(screen.getByRole("toolbar",{name:"시리즈 도구"})).getByText("1장 선택")).toBeInTheDocument();
  expect(document.querySelector(".series-gallery .series-selection")).toBeNull();
  await user.click(screen.getByRole("button",{name:"이 캐릭터에서 제외"}));
  await waitFor(()=>expect(decide).toHaveBeenCalledWith(expect.objectContaining({targetId:"hina",assetIds:["image-5"],decision:"rejected"})));
  expect(screen.queryByText("1장 선택")).not.toBeInTheDocument();
});

it("assigns multiple checked characters in one batch and clears only on success", async () => {
  const { api } = await mount();
  const user = userEvent.setup();
  const batch = vi.spyOn(api, "decideBatch").mockRejectedValueOnce(new Error("저장 실패"));
  await user.click(await screen.findByRole("option", { name: "이미지 5.webp" }));
  const panel = screen.getByRole("region", { name: "선택 이미지 캐릭터 지정" });
  await user.click(within(panel).getByText("캐릭터 지정…"));
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

it("keeps character assignment collapsed and filters the list on demand", async () => {
  await mount(); const user = userEvent.setup();
  await user.click(await screen.findByRole("option", { name: "이미지 5.webp" }));
  const panel = screen.getByRole("region", { name: "선택 이미지 캐릭터 지정" });
  const assignment = within(panel).getByText("캐릭터 지정…").closest("details");
  expect(assignment).not.toHaveAttribute("open");
  await user.click(within(panel).getByText("캐릭터 지정…"));
  expect(assignment).toHaveAttribute("open");
  await user.type(within(panel).getByRole("textbox", { name: "캐릭터 찾기" }), "키사");
  expect(within(panel).getByRole("checkbox", { name: "키사키" })).toBeInTheDocument();
  expect(within(panel).queryByRole("checkbox", { name: "히나" })).not.toBeInTheDocument();
});

it("leads the character panel with references and folds rename and maintenance under 관리", async () => {
  await mount("hina"); const user = userEvent.setup();
  const trigger = await screen.findByRole("button", { name: "캐릭터 더보기" });
  // The trigger is the character glyph, not the generic overflow squares used by 시리즈 더보기.
  expect(trigger.querySelector("path")?.getAttribute("d")).not.toBe("M3 10h4v4H3zM10 10h4v4h-4zM17 10h4v4h-4z");
  await user.click(trigger);
  const panel = await screen.findByRole("dialog", { name: "히나 · 캐릭터 정보" });
  const references = within(panel).getByRole("region", { name: "레퍼런스 목록" });
  expect(references.closest("details")).toBeNull();
  expect(within(panel).getByRole("button", { name: "레퍼런스 추가" }).closest("details")).toBeNull();
  expect(within(references).getByRole("button", { name: "레퍼런스 1 제거" })).toBeVisible();
  const management = within(panel).getByText("관리", { selector: "summary span" }).closest("details");
  expect(management).not.toHaveAttribute("open");
  expect(within(panel).getByLabelText("캐릭터 이름").closest("details")).toBe(management);
  expect(within(panel).queryByText("분류 안내")).not.toBeInTheDocument();
  expect(within(panel).queryByText("추가 관리")).not.toBeInTheDocument();
  expect(within(panel).getByText(/^자동 분류 켜짐/)).toBeVisible();
  expect(within(panel).getByRole("button", { name: "저장" })).toBeVisible();
});

it("hides routine per-character participation controls", async () => {
  await mount("hina"); const user = userEvent.setup();
  await user.click(await screen.findByRole("button", { name: "캐릭터 더보기" }));
  const panel = await screen.findByRole("dialog", { name: "히나 · 캐릭터 정보" });
  expect(within(panel).queryByRole("checkbox", { name: "자동 분석에 사용" })).not.toBeInTheDocument();
  expect(within(panel).queryByRole("button", { name: "자동 분류 다시 사용" })).not.toBeInTheDocument();
});

it("offers recovery when a legacy character is disabled", async () => {
  await mount("hina", false, [], undefined, false, { targetEnabled: false }); const user = userEvent.setup();
  await user.click(await screen.findByRole("button", { name: "캐릭터 더보기" }));
  const panel = await screen.findByRole("dialog", { name: "히나 · 캐릭터 정보" });
  await user.click(within(panel).getByRole("button", { name: "자동 분류 다시 사용" }));
  expect(within(panel).queryByRole("button", { name: "자동 분류 다시 사용" })).not.toBeInTheDocument();
});


it("opens suggested reference reinforcement from character settings and refreshes after applying", async () => {
  const { hubApi, changed } = await mount("hina");
  const user = userEvent.setup();
  const toolbar = screen.getByRole("toolbar", { name: "시리즈 도구" });
  expect(within(toolbar).queryByRole("button", { name: "추천으로 보강" })).not.toBeInTheDocument();
  await user.click(within(toolbar).getByRole("button", { name: "캐릭터 더보기" }));
  const panel = await screen.findByRole("dialog", { name: "히나 · 캐릭터 정보" });
  await user.click(within(panel).getByRole("button", { name: "추천으로 보강" }));

  expect(await screen.findByRole("dialog", { name: "레퍼런스 선택" })).toBeVisible();
  await waitFor(() => expect(hubApi.referenceCandidates).toHaveBeenCalledWith("hina", 20));
  await user.click(screen.getByRole("button", { name: "2장 적용" }));
  await waitFor(() => expect(hubApi.confirmReferenceBatch).toHaveBeenCalledWith(expect.objectContaining({
    targetId: "hina",
    confirmationMode: "add_learned",
    assetIds: ["image-5", "image-6"],
  })));
  await waitFor(() => expect(changed).toHaveBeenCalled());
  expect(screen.queryByRole("dialog", { name: "레퍼런스 선택" })).not.toBeInTheDocument();
});

it("opens manual reference selection from the character folder and saves only the chosen images", async () => {
  const { api, browse, hubApi } = await mount("hina");
  const save = vi.spyOn(api, "saveSettings");
  const user = userEvent.setup();
  await openReferencePicker(user);
  expect(await screen.findByRole("region", { name: "갤러리 이미지 선택" })).toBeVisible();
  expect(screen.getByText("레퍼런스 선택 · 5/25")).toBeVisible();
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  await waitFor(() => expect(browse).toHaveBeenLastCalledWith(expect.objectContaining({ targetId: "hina", referenceTargetId: "hina", all: true })));
  expect(hubApi.referenceCandidates).not.toHaveBeenCalled();
  const candidate = await screen.findByRole("option", { name: "이미지 5.webp" });
  expect(candidate).toHaveAttribute("aria-selected", "false");
  await user.click(candidate);
  await user.click(screen.getByRole("button", { name: "완료" }));
  const panel = await screen.findByRole("dialog", { name: "히나 · 캐릭터 정보" });
  expect(save).not.toHaveBeenCalled();
  await user.click(within(panel).getByRole("button", { name: "저장" }));
  await waitFor(() => expect(save).toHaveBeenCalledWith(expect.objectContaining({ id: "hina", referenceIds: fixtureAssets.slice(0, 6).map(asset => asset.id) }), true));
  expect(hubApi.confirmReferenceBatch).not.toHaveBeenCalled();
});

it("starts historical refresh only after explicit confirmation", async () => {
  const { hubApi } = await mount("hina"); const user = userEvent.setup();
  const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
  await user.click(await screen.findByRole("button", { name: "캐릭터 더보기" }));
  const panel = await screen.findByRole("dialog", { name: "히나 · 캐릭터 정보" });
  const management = within(panel).getByText("관리", { selector: "summary span" }).closest("details");
  expect(management).not.toHaveAttribute("open");
  expect(within(panel).getByRole("button", { name: "과거 미분류 이미지 갱신" })).not.toBeVisible();
  await user.click(within(panel).getByText("관리"));
  const refresh = within(panel).getByRole("button", { name: "과거 미분류 이미지 갱신" });
  await user.click(refresh);
  expect(hubApi.requestReferenceRefresh).not.toHaveBeenCalled();
  confirm.mockReturnValue(true);
  await user.click(refresh);
  await waitFor(() => expect(hubApi.requestReferenceRefresh).toHaveBeenCalledWith("hina", 1));
  expect(confirm).toHaveBeenLastCalledWith(expect.stringContaining("미분류 이미지 전체"));
  expect(await screen.findByText("미분류 이미지 12개 갱신을 예약했습니다. 작업 센터에서 진행 상황을 확인할 수 있습니다.")).toBeVisible();
});

it("limits an existing character portrait picker to its own folder", async () => {
  const { browse } = await mount("hina");
  const user = userEvent.setup();
  await user.click(await screen.findByRole("button", { name: "캐릭터 더보기" }));
  const panel = await screen.findByRole("dialog", { name: "히나 · 캐릭터 정보" });
  await user.click(within(panel).getByText("관리"));
  await user.click(within(panel).getByRole("button", { name: "대표 이미지 선택" }));
  await waitFor(() => expect(browse).toHaveBeenCalledWith(expect.objectContaining({ targetId: "hina", referenceTargetId: "hina", all: true })));
  expect(screen.getByRole("heading", { name: /히나 캐릭터 폴더/ })).toBeVisible();
  expect(screen.queryByRole("button", { name: "미분류만 보기" })).not.toBeInTheDocument();
});

it("allows reference selection from the series after opening the character folder", async () => {
  const {browse}=await mount("hina"); const user=userEvent.setup();
  await user.click(await screen.findByRole("button",{name:"캐릭터 더보기"}));
  const panel=await screen.findByRole("dialog",{name:"히나 · 캐릭터 정보"});
  await user.click(within(panel).getByText("관리"));
  await user.click(within(panel).getByRole("button",{name:"대표 이미지 선택"}));
  await user.click(await screen.findByRole("button",{name:"시리즈에서 이미지 찾기"}));
  await waitFor(()=>expect(browse).toHaveBeenLastCalledWith(expect.objectContaining({targetId:null,referenceTargetId:"hina"})));
  const callsBeforeReturn=browse.mock.calls.length;
  await user.click(screen.getByRole("button",{name:"캐릭터 폴더로 돌아가기"}));
  await screen.findByRole("heading",{name:/히나 캐릭터 폴더/});
  expect(browse).toHaveBeenCalledTimes(callsBeforeReturn);
});

it("shows only character states that need attention on overview cards", async () => {
  await mount();
  await screen.findByRole("button", { name: "히나 열기" });
  expect(screen.queryByLabelText("기준 이미지 준비 완료")).not.toBeInTheDocument();
});

it("places ordinary folders beside characters with navigation and a persisted exclusion action", async () => {
  const { navigate, hubApi, changed } = await mount(undefined, false, [], undefined, false, {
    folders: [{ classificationId: "machines", thumbnailAssetId: "asset-5" }], privacyMode: true,
  });
  const card = await screen.findByRole("button", { name: "기체 폴더 열기" });
  expect(card.closest(".series-characters")).toContainElement(screen.getByRole("button", { name: "히나 열기" }));
  expect(card.querySelector("img")).toHaveClass("character-private");
  const user = userEvent.setup();
  expect(within(card).queryByText("제외")).not.toBeInTheDocument();
  await user.click(card);
  expect(navigate).toHaveBeenCalledWith({ kind: "classification", classificationId: "machines" });
  await user.click(screen.getByRole("button", { name: "기체 폴더 더보기" }));
  await user.click(screen.getByRole("menuitem", { name: "캐릭터 분류에서 제외" }));
  await waitFor(() => expect(hubApi.setFolderExcluded).toHaveBeenCalledWith("machines", true));
  await waitFor(() => expect(changed).toHaveBeenCalled());
});

it("restores folder inclusion and leaves failed saves recoverable", async () => {
  const { hubApi, changed } = await mount(undefined, false, [], undefined, false, {
    folders: [{ classificationId: "machines", thumbnailAssetId: null }], exclusions: ["machines"],
  });
  const card = await screen.findByRole("button", { name: "기체 폴더 열기" });
  expect(card).toHaveAttribute("aria-description", "캐릭터 분류 제외");
  expect(within(card).getByText("제외")).toHaveClass("series-character__tag");
  expect(card.closest("article")).toHaveClass("series-character--excluded");
  vi.mocked(hubApi.setFolderExcluded).mockRejectedValueOnce(new Error("저장 실패"));
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "기체 폴더 더보기" }));
  await user.click(screen.getByRole("menuitem", { name: "캐릭터 분류에 다시 포함" }));
  await screen.findByRole("alert");
  expect(changed).not.toHaveBeenCalled();
  expect(card).toHaveAttribute("aria-description", "캐릭터 분류 제외");
  await user.click(screen.getByRole("button", { name: "기체 폴더 더보기" }));
  await user.click(screen.getByRole("menuitem", { name: "캐릭터 분류에 다시 포함" }));
  await waitFor(() => expect(changed).toHaveBeenCalled());
  expect(hubApi.setFolderExcluded).toHaveBeenLastCalledWith("machines", false);
});


it("copies a character asset source and reports clipboard failures without changing the gallery", async () => {
  const user = userEvent.setup();
  const writeText = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue(undefined);
  const { changed } = await mount("hina", false, [], undefined, false, { sourceUrl: "https://example.com/pilot" });
  const item = await screen.findByRole("option", { name: "이미지 5.webp" });
  await user.pointer({ target: item, keys: "[MouseRight]" });
  await user.click(screen.getByRole("menuitem", { name: "출처 복사" }));
  expect(writeText).toHaveBeenCalledWith("https://example.com/pilot");
  expect(await screen.findByText("출처를 복사했습니다.")).toBeVisible();
  writeText.mockRejectedValueOnce(undefined);
  await user.pointer({ target: item, keys: "[MouseRight]" });
  await user.click(screen.getByRole("menuitem", { name: "출처 복사" }));
  expect(await screen.findByText("출처를 복사하지 못했습니다.")).toBeVisible();
  expect(changed).not.toHaveBeenCalled();
});

// Region inspection is optional and draft-only: it never saves, and it never
// blocks the ordinary character settings flow.
function inspection(assetId: string, state: string, boxes: [number, number, number, number][] = [[10, 20, 110, 220]]) {
  return { assetId, contentHash: `hash-${assetId}`, baselineFingerprint: "baseline", width: 400, height: 600, boxes,
    selectedIndex: null, suggestedIndex: null, automaticIndex: state === "automatic" ? 0 : null, state };
}

async function openReferences(inspect?: (seriesId: string, targetId: string | null, assetIds: string[], regions?: Record<string, unknown>) => Promise<unknown[]>) {
  const user = userEvent.setup();
  const mounted = await mount(undefined, false, [], undefined, false, inspect ? { inspect } : {});
  await user.click(await screen.findByRole("button", { name: "히나 편집" }));
  const panel = await screen.findByRole("dialog", { name: "히나 · 캐릭터 정보" });
  return { ...mounted, user, panel };
}

it("marks required person confirmation before opening info, shares inspection, and restores the mark when edits are discarded", async () => {
  const inspect = vi.fn(async (_series: string, _target: string | null, ids: string[], regions?: Record<string, unknown>) =>
    ids.map((id, index) => index === 0 && !regions?.[id]
      ? inspection(id, "needs_region", [[0, 0, 100, 200], [100, 0, 200, 200]]) : inspection(id, "single")));
  await mount("hina", false, [], undefined, false, { inspect });
  const user = userEvent.setup();
  const info = await screen.findByRole("button", { name: "캐릭터 더보기" });
  await waitFor(() => expect(within(info).getByText("!")).toBeInTheDocument());
  expect(info).toHaveAttribute("aria-description", "필요한 인물 확인이 있습니다.");
  expect(screen.queryByRole("dialog", { name: "히나 · 캐릭터 정보" })).not.toBeInTheDocument();
  expect(inspect).toHaveBeenCalledTimes(1);
  await user.click(info);
  const panel = await screen.findByRole("dialog", { name: "히나 · 캐릭터 정보" });
  await user.click(await within(panel).findByRole("button", { name: "필요한 인물만 확인" }));
  expect(inspect).toHaveBeenCalledTimes(1);
  await user.click(within(panel).getByRole("button", { name: "인물 영역 1 선택" }));
  await waitFor(() => expect(within(info).queryByText("!")).not.toBeInTheDocument());
  expect(inspect).toHaveBeenCalledTimes(2);
  await user.click(within(panel).getByRole("button", { name: "히나 · 캐릭터 정보 닫기" }));
  await waitFor(() => expect(within(info).getByText("!")).toBeInTheDocument());
});

it("does not mark optional correction when six references are usable", async () => {
  const references = Array.from({ length: 7 }, (_, slot) => ({ slot, assetId: `image-${slot}`, assetHash: `hash-${slot}`, status: "ready" }));
  const inspect = vi.fn(async (_series: string, _target: string | null, ids: string[]) => ids.map((id, index) =>
    inspection(id, index === 6 ? "needs_region" : "single")));
  await mount("hina", false, [], undefined, false, { inspect, targetOverrides: { references } });
  const info = await screen.findByRole("button", { name: "캐릭터 더보기" });
  await waitFor(() => expect(inspect).toHaveBeenCalledTimes(1));
  expect(within(info).queryByText("!")).not.toBeInTheDocument();
  await userEvent.setup().click(info);
  const panel = await screen.findByRole("dialog", { name: "히나 · 캐릭터 정보" });
  expect(within(panel).queryByRole("button", { name: "필요한 인물만 확인" })).not.toBeInTheDocument();
  expect(inspect).toHaveBeenCalledTimes(1);
});

it("marks a failed inspection and clears it after retrying from character info", async () => {
  const inspect = vi.fn().mockRejectedValueOnce(new Error("인물 확인 실패"))
    .mockImplementation(async (_series: string, _target: string | null, ids: string[]) => ids.map(id => inspection(id, "single")));
  await mount("hina", false, [], undefined, false, { inspect });
  const info = await screen.findByRole("button", { name: "캐릭터 더보기" });
  await waitFor(() => expect(within(info).getByText("!")).toBeInTheDocument());
  expect(info).toHaveAttribute("aria-description", expect.stringContaining("확인 실패"));
  const user = userEvent.setup();
  await user.click(info);
  await user.click(await screen.findByRole("button", { name: "인물 확인 다시 시도" }));
  await waitFor(() => expect(within(info).queryByText("!")).not.toBeInTheDocument());
  await waitFor(() => expect(inspect).toHaveBeenCalledTimes(2));
});

it.each([{ targetEnabled: false }, { targetOverrides: { manualOnly: true } }])("does not inspect disabled or manual-only characters for the badge: %j", async options => {
  const inspect = vi.fn(async () => []);
  await mount("hina", false, [], undefined, false, { ...options, inspect });
  const info = await screen.findByRole("button", { name: "캐릭터 더보기" });
  expect(within(info).queryByText("!")).not.toBeInTheDocument();
  expect(inspect).not.toHaveBeenCalled();
});

it("sends only changed manual regions so unchanged settings do not require detector validation", () => {
  const original: ReferenceRegion = { contentHash: "hash", baselineFingerprint: "baseline", bounds: [0, 0, 40, 50] };
  const saved = { a: original };
  expect(draftReferenceRegions({ a: { ...original, bounds: [...original.bounds] } }, ["a"], saved)).toEqual({});
  const changed: ReferenceRegion = { ...original, bounds: [40, 0, 80, 50] };
  expect(draftReferenceRegions({ a: changed, removed: original }, ["a"], saved)).toEqual({ a: changed });
  expect(draftReferenceRegions({ a: { ...original, baselineFingerprint: "new" } }, ["a"], saved)).toHaveProperty("a");
  expect(draftReferenceRegions({ a: { ...original, contentHash: "new" } }, ["a"], saved)).toHaveProperty("a");
});

it("never prompts for unambiguous references and still inspects read-only", async () => {
  const inspect = vi.fn(async (_seriesId: string, _targetId: string | null, assetIds: string[]) => assetIds.map(id => inspection(id, "single")));
  const mounted = await mount(undefined, false, [], undefined, false, { inspect });
  const saveSettings = vi.spyOn(mounted.api, "saveSettings");
  const user = userEvent.setup();
  await user.click(await screen.findByRole("button", { name: "히나 편집" }));
  const panel = await screen.findByRole("dialog", { name: "히나 · 캐릭터 정보" });
  // Five single-person references leave nothing to ask, so the section stays out of the way.
  await waitFor(() => expect(inspect).toHaveBeenCalledWith("series", "hina", expect.arrayContaining(["image-0"]), {}));
  expect(within(panel).queryByRole("region", { name: "인물 영역 확인" })).not.toBeInTheDocument();
  expect(within(panel).queryByRole("button", { name: "필요한 인물만 확인" })).not.toBeInTheDocument();
  expect(saveSettings).not.toHaveBeenCalled();
  expect(mounted.changed).not.toHaveBeenCalled();
});

it("asks for one unresolved reference and stores the choice in the draft only", async () => {
  // A multi-person image keeps its boxes after a choice, so the region stays replaceable.
  const inspect = vi.fn(async (_seriesId: string, _targetId: string | null, assetIds: string[]) =>
    assetIds.map(id => id === "image-0"
      ? inspection(id, "needs_region", [[10, 20, 110, 220], [200, 40, 380, 520]])
      : inspection(id, "single")));
  const mounted = await mount(undefined, false, [], undefined, false, { inspect });
  const saveSettings = vi.spyOn(mounted.api, "saveSettings");
  const user = userEvent.setup();
  await user.click(await screen.findByRole("button", { name: "히나 편집" }));
  const panel = await screen.findByRole("dialog", { name: "히나 · 캐릭터 정보" });
  await user.click(await within(panel).findByRole("button", { name: "필요한 인물만 확인" }));
  await user.click(await within(panel).findByRole("button", { name: "인물 영역 2 선택" }));
  // The correction list is reached only through the optional adjustment action.
  await user.click(await within(panel).findByRole("button", { name: "인물 영역 조정" }));
  const regions = await within(panel).findByRole("region", { name: "인물 영역 목록" });
  expect(within(regions).getByRole("button", { name: "레퍼런스 1 인물 영역 변경" })).toBeInTheDocument();
  // Choosing a region changes the draft only; nothing is written until save.
  expect(saveSettings).not.toHaveBeenCalled();
  expect(mounted.changed).not.toHaveBeenCalled();
  await user.click(within(panel).getByRole("button", { name: "저장" }));
  await waitFor(() => expect(saveSettings).toHaveBeenCalledWith(expect.objectContaining({ referenceRegions: { "image-0": { contentHash: "hash-image-0", baselineFingerprint: "baseline", bounds: [200, 40, 380, 520] } } }), true));
});

it("keeps asking only through the quiet button until the requirement is met", async () => {
  const calls: { regions: Record<string, unknown> }[] = [];
  const inspect = vi.fn(async (_seriesId: string, _targetId: string | null, assetIds: string[], regions?: Record<string, unknown>) => {
    calls.push({ regions: { ...regions } });
    // Five references plus one extra: six usable references is only reached after a pick.
    return [...assetIds, "image-extra"].map(id => regions?.[id] ? inspection(id, "selected")
      : id === "image-0" ? inspection(id, "needs_region", [[10, 20, 110, 220], [200, 40, 380, 520]]) : inspection(id, "single"));
  });
  const { user, panel } = await openReferences(inspect);
  // The chooser is closed until the user asks for it.
  expect(within(panel).queryByRole("button", { name: /인물 영역 \d+ 선택/ })).not.toBeInTheDocument();
  await user.click(await within(panel).findByRole("button", { name: "필요한 인물만 확인" }));
  await user.click(await within(panel).findByRole("button", { name: "인물 영역 2 선택" }));
  // The confirmed choice is included in the next inspection request.
  await waitFor(() => expect(calls.some(call => call.regions["image-0"])).toBe(true));
  // Six usable references are reached, so the requirement becomes an optional correction.
  expect(await within(panel).findByRole("button", { name: "인물 영역 조정" })).toBeInTheDocument();
  expect(within(panel).queryByRole("button", { name: "필요한 인물만 확인" })).not.toBeInTheDocument();
});

it("keeps a manual region choice for replacement and drops it when its reference is removed", async () => {
  const inspect = vi.fn(async (_seriesId: string, _targetId: string | null, assetIds: string[]) =>
    assetIds.map(id => id === "image-0" ? inspection(id, "needs_region", [[10, 20, 110, 220], [200, 40, 380, 520]]) : inspection(id, "single")));
  const mounted = await mount(undefined, false, [], undefined, false, { inspect });
  const saveSettings = vi.spyOn(mounted.api, "saveSettings");
  const user = userEvent.setup();
  await user.click(await screen.findByRole("button", { name: "히나 편집" }));
  const panel = await screen.findByRole("dialog", { name: "히나 · 캐릭터 정보" });
  await user.click(await within(panel).findByRole("button", { name: "필요한 인물만 확인" }));
  await user.click(await within(panel).findByRole("button", { name: "인물 영역 2 선택" }));
  await user.click(await within(panel).findByRole("button", { name: "인물 영역 조정" }));
  const regions = await within(panel).findByRole("region", { name: "인물 영역 목록" });
  expect(within(regions).getByRole("button", { name: "레퍼런스 1 인물 영역 변경" })).toBeInTheDocument();
  // Removing the reference also drops the region that belonged to it.
  await user.click(within(panel).getByRole("button", { name: "레퍼런스 1 제거" }));
  await waitFor(() => expect(within(panel).queryByRole("region", { name: "인물 영역 목록" })).not.toBeInTheDocument());
  await user.click(within(panel).getByRole("button", { name: "저장" }));
  // The removed reference's region is never saved back.
  await waitFor(() => expect(saveSettings).toHaveBeenCalled());
  expect(saveSettings).not.toHaveBeenCalledWith(expect.objectContaining({ referenceRegions: expect.objectContaining({ "image-0": expect.anything() }) }), true);
});

it("skips region inspection entirely when the host does not expose it", async () => {
  const mounted = await mount();
  const user = userEvent.setup();
  await user.click(await screen.findByRole("button", { name: "히나 편집" }));
  const panel = await screen.findByRole("dialog", { name: "히나 · 캐릭터 정보" });
  expect(within(panel).queryByRole("region", { name: "인물 영역 확인" })).not.toBeInTheDocument();
  expect(mounted.api.inspectReferenceRegions).toBeUndefined();
});

it("opens the S36 review from the series overflow, not the gallery heading", async () => {
  const { shadowApi } = await mount(undefined);
  const user = userEvent.setup();
  await screen.findByRole("radiogroup", { name: "시리즈 이미지 필터" });
  expect(screen.queryByRole("button", { name: "S36 확인" })).not.toBeInTheDocument();
  expect(screen.queryByRole("radiogroup", { name: "자동 분류 방식" })).not.toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "시리즈 더보기" }));
  await user.click(await screen.findByRole("menuitem", { name: "S36 시험 채점 확인" }));
  const dialog = await screen.findByRole("dialog", { name: "S36 확인" });
  expect(await within(dialog).findByRole("heading", { name: "확인할 항목이 없습니다" })).toBeInTheDocument();
  expect(shadowApi.page).toHaveBeenCalledWith({ offset: 0, limit: 40 });
  await user.click(within(dialog).getByRole("button", { name: "S36 확인 닫기" }));
  await waitFor(() => expect(screen.queryByRole("dialog", { name: "S36 확인" })).not.toBeInTheDocument());
});

it("shows waiting candidates as a quiet action on the series count line, not a banner", async () => {
  vi.spyOn(s36PublicationApi, "get").mockResolvedValue({ series: ["series"], excludedTargets: [], scoringEnabled: true });
  vi.spyOn(s36PublicationApi, "readiness").mockResolvedValue([]);
  const { shadowApi } = await mount(undefined, false, [], undefined, false, { candidates: 37, shadowItems: ["a1"] });
  const user = userEvent.setup();
  const review = await screen.findByRole("button", { name: "후보 37 확인" });
  expect(shadowApi.page).toHaveBeenCalledWith({ offset: 0, limit: 1 });
  expect(review).not.toHaveClass("ui-button--primary");
  expect(screen.queryByRole("region", { name: "확인할 후보" })).not.toBeInTheDocument();
  const heading = review.closest(".character-group-heading")!;
  expect(within(heading as HTMLElement).getByRole("heading")).toHaveTextContent("캐릭터 2");
  const toolbar = screen.getByRole("toolbar", { name: "시리즈 도구" });
  expect(within(toolbar).queryByRole("button", { name: /후보/ })).not.toBeInTheDocument();
  await user.click(review);
  expect(await screen.findByRole("dialog", { name: "S36 확인" })).toBeInTheDocument();
});

it("hides the candidate action inside a character", async () => {
  vi.spyOn(s36PublicationApi, "get").mockResolvedValue({ series: ["series"], excludedTargets: [], scoringEnabled: true });
  vi.spyOn(s36PublicationApi, "readiness").mockResolvedValue([]);
  await mount("hina", false, [], undefined, false, { candidates: 37 });
  await screen.findByRole("option", { name: "이미지 5.webp" });
  expect(screen.queryByRole("button", { name: /후보 .* 확인/ })).not.toBeInTheDocument();
});

it("hides 후보 확인 on a series that does not use S36", async () => {
  vi.spyOn(s36PublicationApi, "get").mockResolvedValue({ series: [], excludedTargets: [], scoringEnabled: true });
  vi.spyOn(s36PublicationApi, "readiness").mockResolvedValue([]);
  const { shadowApi } = await mount(undefined, false, [], undefined, false, { candidates: 37 });
  await waitFor(() => expect(shadowApi.page).toHaveBeenCalledWith({ offset: 0, limit: 1 }));
  expect(screen.queryByRole("button", { name: /후보 .* 확인/ })).not.toBeInTheDocument();
});

it("hides 후보 확인 when nothing waits", async () => {
  const { shadowApi } = await mount(undefined);
  await waitFor(() => expect(shadowApi.page).toHaveBeenCalledWith({ offset: 0, limit: 1 }));
  expect(screen.queryByRole("button", { name: /후보 .* 확인/ })).not.toBeInTheDocument();
});

it("moves FAULT and the S36 series control into the series overflow", async () => {
  vi.spyOn(s36PublicationApi, "get").mockResolvedValue({ series: [], excludedTargets: [], scoringEnabled: true });
  vi.spyOn(s36PublicationApi, "readiness").mockResolvedValue([]);
  await mount(undefined, false, [], undefined, false, { fault: true });
  const user = userEvent.setup();
  const toolbar = screen.getByRole("toolbar", { name: "시리즈 도구" });
  await screen.findByRole("option", { name: "이미지 5.webp" });
  expect(within(toolbar).queryByRole("button", { name: "이 묶음으로 플레이" })).not.toBeInTheDocument();
  expect(screen.queryByRole("status", { name: /S36/ })).not.toBeInTheDocument();
  await user.click(within(toolbar).getByRole("button", { name: "시리즈 더보기" }));
  expect(await screen.findByRole("menuitem", { name: "FAULT로 플레이" })).toBeInTheDocument();
  expect(screen.getByRole("menuitem", { name: "S36 시험 채점 확인" })).toBeInTheDocument();
  await user.click(screen.getByRole("menuitem", { name: "S36 자동 분류 설정" }));
  const dialog = await screen.findByRole("dialog", { name: "S36 자동 분류" });
  expect(within(dialog).getByRole("radiogroup", { name: "자동 분류 방식" })).toBeInTheDocument();
});

it("shows S36 recovery in the header only while S36 classification is stalled", async () => {
  vi.spyOn(s36PublicationApi, "get").mockResolvedValue({ series: ["series"], excludedTargets: [], scoringEnabled: false });
  vi.spyOn(s36PublicationApi, "readiness").mockResolvedValue([]);
  await mount(undefined);
  expect(await screen.findByText("S36 시험 채점이 꺼져 자동 분류가 멈춰 있습니다")).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "자동 분류 다시 켜기" })).not.toBeInTheDocument();
});

it("reaches each reference's crop check in one tap from the character panel and saves the choice", async () => {
  const inspect = vi.fn(async (_series: string, _target: string | null, ids: string[]) => ids.map(id => id === "image-2"
    ? inspection(id, "automatic", [[0, 0, 100, 200], [100, 0, 200, 200]]) : inspection(id, "single")));
  const { api } = await mount("hina", false, [], undefined, false, { inspect });
  const save = vi.spyOn(api, "saveSettings");
  const user = userEvent.setup();
  await user.click(await screen.findByRole("button", { name: "캐릭터 더보기" }));
  const panel = await screen.findByRole("dialog", { name: "히나 · 캐릭터 정보" });
  const list = within(panel).getByRole("region", { name: "레퍼런스 목록" });
  await user.click(await within(list).findByRole("button", { name: "레퍼런스 3 크롭 확인" }));
  await user.click(within(panel).getByRole("button", { name: "인물 영역 2 선택" }));
  expect(within(panel).getByText("저장하지 않은 변경")).toBeVisible();
  await user.click(within(panel).getByRole("button", { name: "저장" }));
  await waitFor(() => expect(save).toHaveBeenCalledWith(expect.objectContaining({
    referenceRegions: { "image-2": { contentHash: "hash-image-2", baselineFingerprint: "baseline", bounds: [100, 0, 200, 200] } },
  }), true));
});
