import { within } from "@testing-library/react";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { LibraryProvider } from "../library/LibraryContext";
import type { LibraryGateway } from "../library/types";
import { CharacterGroups } from "./CharacterGroups";
import { CharacterConversion } from "./CharacterConversion";
import { CharacterFolderOrganizer } from "./CharacterFolderOrganizer";
import { CharacterFolderContent } from "./CharacterFolderContent";
import { FolderRegistrationContext } from "./FolderRegistrationContext";
import { fixtureAssets, fixtureClassifications, fixtureTarget } from "./characterFixtures";
vi.mock("@tauri-apps/api/core",()=>({invoke:vi.fn(),isTauri:()=>false,convertFileSrc:vi.fn()}));
afterEach(()=>{cleanup();vi.resetAllMocks();});
it("creates a display group and keeps its characters accessible",async()=>{
  const groups:any[]=[];
  vi.mocked(invoke).mockImplementation(async(command,args:any)=>{
    if(command==="character_groups")return [...groups];
    if(command==="save_character_group")groups.push({id:"g",name:args.request.name,revision:1,targetIds:args.request.targetIds});
  });
  render(<CharacterGroups seriesId="series" members={[fixtureTarget()]}>{members=><div>{members.map(target=><span key={target.id}>{target.displayName} 카드</span>)}</div>}</CharacterGroups>);
  const user=userEvent.setup();
  await user.click(screen.getByRole("button",{name:"그룹 만들기"}));
  await user.type(screen.getByRole("textbox",{name:"그룹 이름"}),"학생회");
  expect(screen.getByRole("button", { name: "저장" })).toBeDisabled();
  await user.click(screen.getByRole("checkbox",{name:"히나"}));
  await user.click(screen.getByRole("button",{name:"저장"}));
  expect(await screen.findByRole("button",{name:"학생회 그룹 열기"})).toBeInTheDocument();
  expect(screen.queryByText("히나 카드")).not.toBeInTheDocument();
  expect(invoke).toHaveBeenCalledWith("save_character_group",{request:expect.objectContaining({seriesId:"series",targetIds:["hina"],name:"학생회"})});
  cleanup();
  render(<CharacterGroups seriesId="series" members={[fixtureTarget()]} groups={[{id:"g",name:"학생회",revision:1,targetIds:["hina"]}]} activeGroupId="g">{members=><div>{members.map(target=><span key={target.id}>{target.displayName} 카드</span>)}</div>}</CharacterGroups>);
  expect(screen.getByText("히나 카드")).toBeInTheDocument();
});

it("dissolves an active group after its last member is unchecked and returns to the series", async () => {
  const onOpenGroup = vi.fn(), onGroupsChanged = vi.fn();
  vi.mocked(invoke).mockResolvedValue(undefined);
  render(<CharacterGroups seriesId="series" members={[fixtureTarget()]} groups={[{ id: "g", name: "학생회", revision: 2, targetIds: ["hina"] }]} activeGroupId="g" onOpenGroup={onOpenGroup} onGroupsChanged={onGroupsChanged}>{() => null}</CharacterGroups>);
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "그룹 편집" }));
  await user.click(screen.getByRole("checkbox", { name: "히나" }));
  await user.click(screen.getByRole("button", { name: "빈 그룹 해제" }));
  await waitFor(() => expect(onOpenGroup).toHaveBeenCalledWith(null));
  expect(onGroupsChanged).toHaveBeenCalledOnce();
  expect(invoke).toHaveBeenCalledWith("save_character_group", { request: { id: "g", seriesId: "series", expectedRevision: 2, name: "학생회", targetIds: [], delete: false } });
});

it("keeps Originals as storage-only without series or character registration tools",()=>{
  const classifications=[
    {id:"originals",name:"오리지널",kind:"root" as const,parentId:null,iconKey:"sparkles",colorKey:null},
    {id:"oc",name:"내 캐릭터",kind:"tag" as const,parentId:"originals",iconKey:null,colorKey:null},
  ];
  const hub={targets:[],series:[],groups:[],error:null,refresh:vi.fn(),revision:0} as any;
  render(<CharacterFolderContent view={{kind:"classification",classificationId:"oc"}} hub={hub} classifications={classifications} galleryLayout="masonry" onGalleryLayoutChange={()=>{}} privacyMode={false} onPrivacyModeChange={()=>{}} metadataVisible onMetadataVisibleChange={()=>{}} thumbnailRowHeight={180} onThumbnailRowHeightChange={()=>{}} refreshVersion={0} onNavigate={()=>{}} onAssetsChanged={()=>{}}>
    <FolderRegistrationContext.Consumer>{tools=><span>{tools ? "분류 도구 있음" : "오리지널 보관"}</span>}</FolderRegistrationContext.Consumer>
  </CharacterFolderContent>);
  expect(screen.getByText("오리지널 보관")).toBeInTheDocument();
});

it("keeps one-time registration tools out of root classifications",()=>{
  const classifications=[
    {id:"root",name:"만화",kind:"root" as const,parentId:null,iconKey:null,colorKey:null},
    {id:"series",name:"던전밥",kind:"tag" as const,parentId:"root",iconKey:null,colorKey:null},
  ];
  const hub={targets:[],series:[{classificationId:"series",heroAssetId:null,autoClassify:true}],groups:[],error:null,refresh:vi.fn(),revision:0} as any;
  render(<CharacterFolderContent view={{kind:"classification",classificationId:"root"}} hub={hub} classifications={classifications} galleryLayout="masonry" onGalleryLayoutChange={()=>{}} privacyMode={false} onPrivacyModeChange={()=>{}} metadataVisible onMetadataVisibleChange={()=>{}} thumbnailRowHeight={180} onThumbnailRowHeightChange={()=>{}} refreshVersion={0} onNavigate={()=>{}} onAssetsChanged={()=>{}}>
    <FolderRegistrationContext.Consumer>{tools=><div>{tools}</div>}</FolderRegistrationContext.Consumer>
  </CharacterFolderContent>);
  expect(screen.queryByRole("button",{name:"작품 후보"})).not.toBeInTheDocument();
  expect(screen.queryByRole("button",{name:"시리즈로 등록"})).not.toBeInTheDocument();
  expect(screen.queryByRole("button",{name:"캐릭터로 만들기"})).not.toBeInTheDocument();
  expect(screen.queryByRole("button",{name:"폴더 더보기"})).not.toBeInTheDocument();
});

it("keeps child-folder conversion and registration reachable from one menu",async()=>{
  const gateway={listAssets:vi.fn().mockResolvedValue({items:[],nextCursor:null})} as unknown as LibraryGateway;
  vi.mocked(invoke).mockImplementation(async command => command === "character_folder_asset_snapshot" ? {count:5,fingerprint:"snapshot"} : undefined);
  const refresh=vi.fn();
  const hub={targets:[],series:[],groups:[],error:null,refresh,revision:0} as any;
  render(<LibraryProvider gateway={gateway}><CharacterFolderContent view={{kind:"classification",classificationId:"child"}} hub={hub} classifications={fixtureClassifications} galleryLayout="masonry" onGalleryLayoutChange={()=>{}} privacyMode={false} onPrivacyModeChange={()=>{}} metadataVisible onMetadataVisibleChange={()=>{}} thumbnailRowHeight={180} onThumbnailRowHeightChange={()=>{}} refreshVersion={0} onNavigate={()=>{}} onAssetsChanged={()=>{}}>
    <FolderRegistrationContext.Consumer>{tools=><div>{tools}</div>}</FolderRegistrationContext.Consumer>
  </CharacterFolderContent></LibraryProvider>);
  const user=userEvent.setup();
  expect(screen.queryByRole("button",{name:"시리즈로 등록"})).not.toBeInTheDocument();
  expect(screen.queryByRole("button",{name:"캐릭터로 만들기"})).not.toBeInTheDocument();
  await user.click(screen.getByRole("button",{name:"폴더 더보기"}));
  await user.click(screen.getByRole("menuitem",{name:"캐릭터로 만들기"}));
  expect(await screen.findByRole("dialog",{name:"한 캐릭터 폴더 정리"})).toBeVisible();
  await user.click(screen.getByRole("button",{name:"취소"}));
  await user.click(screen.getByRole("button",{name:"폴더 더보기"}));
  await user.click(screen.getByRole("menuitem",{name:"시리즈로 등록"}));
  await waitFor(()=>expect(invoke).toHaveBeenCalledWith("save_character_series",{request:{classificationId:"child",heroAssetId:null,autoClassify:true}}));
  expect(refresh).toHaveBeenCalled();
});

it("requires the preview and exact character name before merging folders",async()=>{
  vi.mocked(invoke).mockImplementation(async(command)=>command==="character_conversion_preview"?{targetId:"hina",name:"히나",seriesId:"series",destinationId:"folder",assetCount:6,sharedCount:1,unavailableCount:0,token:"preview-token"}:"folder");
  const converted=vi.fn();
  render(<CharacterConversion targetId="hina" onClose={()=>{}} onConverted={converted}/>);
  const user=userEvent.setup();
  await user.click(await screen.findByRole("button",{name:"내용 확인 · 계속"}));
  const submit=screen.getByRole("button",{name:"확인한 내용으로 전환"});
  expect(submit).toBeDisabled();
  await user.type(screen.getByRole("textbox",{name:"확인: 히나 입력"}),"히나");
  await user.click(submit);
  await waitFor(()=>expect(converted).toHaveBeenCalledWith("folder"));
  expect(invoke).toHaveBeenCalledWith("convert_character_to_folder",{targetId:"hina",token:"preview-token",confirmation:"히나"});
});

it("opens the curated-folder character conversion directly", async () => {
  const gateway={listAssets:vi.fn().mockResolvedValue({items:[],nextCursor:null})} as unknown as LibraryGateway;
  vi.mocked(invoke).mockImplementation(async command => command === "character_folder_asset_snapshot" ? {count:5,fingerprint:"snapshot"} : undefined);
  render(<LibraryProvider gateway={gateway}><CharacterFolderOrganizer folderId="child" classifications={fixtureClassifications} targets={[fixtureTarget()]} privacyMode={false} onClose={()=>{}} onSingleSaved={()=>{}} /></LibraryProvider>);
  const dialog=await screen.findByRole("dialog",{name:"한 캐릭터 폴더 정리"});
  expect(screen.queryByRole("button",{name:/여러 캐릭터가 섞인 폴더/})).not.toBeInTheDocument();
  expect(within(dialog).queryByText(/기준 이미지/)).not.toBeInTheDocument();
  expect(within(dialog).getByText(/대표 이미지/)).toBeInTheDocument();
});

it("offers reference suggestions after curated-folder conversion and keeps conversion when deferred", async () => {
  const assets=fixtureAssets.slice(0,5);
  const gateway={listAssets:vi.fn().mockResolvedValue({items:assets,nextCursor:null})} as unknown as LibraryGateway;
  const manual={...fixtureTarget("manual","마커스"),manualOnly:true,ready:false,references:[]};
  vi.mocked(invoke).mockImplementation(async(command)=>{
    if(command==="character_folder_asset_snapshot")return {count:5,fingerprint:"snapshot"};
    if(command==="register_character_folder")return {target:manual,linkedAssetCount:5,referenceCandidateCount:5,sourceFolderRemoved:true};
    if(command==="reference_candidates")return {targetId:"manual",targetRevision:manual.revision,referenceSetHash:"set",confirmationMode:"initialize",minimumSelection:5,items:assets,suggestedAssetIds:assets.map(item=>item.id)};
    return undefined;
  });
  const saved=vi.fn();
  render(<LibraryProvider gateway={gateway}><CharacterFolderOrganizer folderId="child" classifications={fixtureClassifications} targets={[]} privacyMode={false} onClose={()=>{}} onSingleSaved={saved} /></LibraryProvider>);
  await userEvent.setup().click(await screen.findByRole("button",{name:"캐릭터로 전환"}));
  expect(await screen.findByRole("dialog",{name:"레퍼런스 선택"})).toBeVisible();
  expect(saved).not.toHaveBeenCalled();
  await userEvent.setup().click(screen.getByRole("button",{name:"나중에"}));
  expect(saved).toHaveBeenCalledWith(manual);
  expect(vi.mocked(invoke).mock.calls.some(([command])=>command==="confirm_reference_batch")).toBe(false);
});

it("shows inherited folder exclusions and lets the owning folder restore inclusion", async () => {
  const classifications = [...fixtureClassifications, { id: "nested", name: "바리에이션", kind: "tag" as const, parentId: "child", iconKey: null, colorKey: null }];
  const hub = { targets: [], series: [{ classificationId: "series", heroAssetId: null, autoClassify: true }], groups: [], folderExclusions: ["child"], error: null, refresh: vi.fn(), revision: 0 } as any;
  vi.mocked(invoke).mockResolvedValue(undefined);
  const show = (id: string) => <CharacterFolderContent view={{ kind: "classification", classificationId: id }} hub={hub} classifications={classifications} galleryLayout="masonry" onGalleryLayoutChange={() => {}} privacyMode={false} onPrivacyModeChange={() => {}} metadataVisible onMetadataVisibleChange={() => {}} thumbnailRowHeight={180} onThumbnailRowHeightChange={() => {}} refreshVersion={0} onNavigate={() => {}} onAssetsChanged={() => {}}>
    <FolderRegistrationContext.Consumer>{tools => <div>{tools}</div>}</FolderRegistrationContext.Consumer>
  </CharacterFolderContent>;
  const view = render(show("nested"));
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "폴더 더보기" }));
  expect(screen.getByRole("menuitem", { name: "히나 폴더에서 분류 제외됨" })).toHaveAttribute("aria-disabled", "true");
  await user.keyboard("{Escape}");
  hub.folderExclusions = ["child", "nested"];
  view.rerender(show("nested"));
  await user.click(screen.getByRole("button", { name: "폴더 더보기" }));
  expect(screen.getByRole("menuitem", { name: "이 폴더의 제외 설정 해제" })).toBeEnabled();
  await user.keyboard("{Escape}");
  hub.folderExclusions = ["child"];
  view.rerender(show("child"));
  await user.click(screen.getByRole("button", { name: "폴더 더보기" }));
  await user.click(screen.getByRole("menuitem", { name: "캐릭터 분류에 다시 포함" }));
  await waitFor(() => expect(invoke).toHaveBeenCalledWith("set_character_folder_excluded", { request: { classificationId: "child", excluded: false } }));
  expect(hub.refresh).toHaveBeenCalled();
});


it("paginates groups, characters and folders in two rows and clamps the page after resizing", async () => {
  let resize = () => {};
  vi.stubGlobal("ResizeObserver", class {
    constructor(callback: () => void) { resize = callback; }
    observe() {} disconnect() {} unobserve() {}
  });
  try {
    const members = Array.from({ length: 7 }, (_, index) => fixtureTarget(`pilot-${index}`, `파일럿 ${index}`));
    const group = { id: "group", name: "파일럿 그룹", revision: 1, targetIds: [members[0].id] };
    const view = render(<CharacterGroups seriesId="series" members={members} groups={[group]} folderCards={[
      <button key="machines">기체 폴더</button>, <button key="scenery">배경 폴더</button>,
    ]}>{pageMembers => <>{pageMembers.map(member => <button key={member.id}>{member.displayName}</button>)}</>}</CharacterGroups>);
    const grid = view.container.querySelector(".series-characters")!;
    Object.defineProperty(grid, "clientWidth", { configurable: true, value: 400 });
    act(() => resize());
    expect(screen.getByRole("button", { name: "파일럿 그룹 그룹 열기" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "파일럿 3" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "파일럿 4" })).not.toBeInTheDocument();
    const pages = screen.getByRole("navigation", { name: "캐릭터·폴더 페이지" });
    expect(within(pages).getByRole("button", { name: "1페이지" })).toHaveAttribute("aria-current", "page");
    const user = userEvent.setup();
    await user.click(within(pages).getByRole("button", { name: "2페이지" }));
    expect(screen.getByRole("button", { name: "파일럿 4" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "기체 폴더" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "파일럿 3" })).not.toBeInTheDocument();
    await user.click(within(pages).getByRole("button", { name: "3페이지" }));
    expect(screen.getByRole("button", { name: "배경 폴더" })).toBeInTheDocument();
    Object.defineProperty(grid, "clientWidth", { configurable: true, value: 600 });
    act(() => resize());
    expect(within(pages).queryByRole("button", { name: "3페이지" })).not.toBeInTheDocument();
    expect(within(pages).getByRole("button", { name: "2페이지" })).toHaveAttribute("aria-current", "page");
    expect(screen.getByRole("button", { name: "배경 폴더" })).toBeInTheDocument();
    view.rerender(<CharacterGroups seriesId="series" members={members.slice(0, 1)} groups={[]}>{pageMembers => <>{pageMembers.map(member => <button key={member.id}>{member.displayName}</button>)}</>}</CharacterGroups>);
    expect(screen.queryByRole("navigation", { name: "캐릭터·폴더 페이지" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "파일럿 0" })).toBeInTheDocument();
    view.unmount();
  } finally { vi.unstubAllGlobals(); }
});
