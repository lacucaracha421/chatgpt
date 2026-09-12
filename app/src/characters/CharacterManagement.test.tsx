import { within } from "@testing-library/react";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
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
  await user.click(screen.getByRole("checkbox",{name:"히나"}));
  await user.click(screen.getByRole("button",{name:"저장"}));
  expect(await screen.findByRole("button",{name:"학생회 그룹 열기"})).toBeInTheDocument();
  expect(screen.queryByText("히나 카드")).not.toBeInTheDocument();
  expect(invoke).toHaveBeenCalledWith("save_character_group",{request:expect.objectContaining({seriesId:"series",targetIds:["hina"],name:"학생회"})});
  cleanup();
  render(<CharacterGroups seriesId="series" members={[fixtureTarget()]} groups={[{id:"g",name:"학생회",revision:1,targetIds:["hina"]}]} activeGroupId="g">{members=><div>{members.map(target=><span key={target.id}>{target.displayName} 카드</span>)}</div>}</CharacterGroups>);
  expect(screen.getByText("히나 카드")).toBeInTheDocument();
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

it("does not offer broad series guessing from a root classification",()=>{
  const classifications=[
    {id:"root",name:"만화",kind:"root" as const,parentId:null,iconKey:null,colorKey:null},
    {id:"series",name:"던전밥",kind:"tag" as const,parentId:"root",iconKey:null,colorKey:null},
  ];
  const hub={targets:[],series:[{classificationId:"series",heroAssetId:null,autoClassify:true}],groups:[],error:null,refresh:vi.fn(),revision:0} as any;
  render(<CharacterFolderContent view={{kind:"classification",classificationId:"root"}} hub={hub} classifications={classifications} galleryLayout="masonry" onGalleryLayoutChange={()=>{}} privacyMode={false} onPrivacyModeChange={()=>{}} metadataVisible onMetadataVisibleChange={()=>{}} thumbnailRowHeight={180} onThumbnailRowHeightChange={()=>{}} refreshVersion={0} onNavigate={()=>{}} onAssetsChanged={()=>{}}>
    <FolderRegistrationContext.Consumer>{tools=><div>{tools}</div>}</FolderRegistrationContext.Consumer>
  </CharacterFolderContent>);
  expect(screen.queryByRole("button",{name:"작품 후보"})).not.toBeInTheDocument();
  expect(screen.getByRole("button",{name:"시리즈로 등록"})).toBeInTheDocument();
  expect(screen.getByRole("button",{name:"캐릭터로 만들기"})).toBeInTheDocument();
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
