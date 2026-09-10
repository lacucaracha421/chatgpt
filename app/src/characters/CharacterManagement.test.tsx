import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { CharacterGroups } from "./CharacterGroups";
import { CharacterConversion } from "./CharacterConversion";
import { CharacterFolderOrganizer } from "./CharacterFolderOrganizer";
import { CharacterFolderContent } from "./CharacterFolderContent";
import { FolderRegistrationContext } from "./FolderRegistrationContext";
import { MixedCharacterFolderMigration } from "./MixedCharacterFolderMigration";
import { fixtureClassifications, fixtureTarget } from "./characterFixtures";
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
  render(<CharacterFolderContent view={{kind:"classification",classificationId:"oc"}} hub={hub} classifications={classifications} privacyMode={false} metadataVisible thumbnailRowHeight={180} refreshVersion={0} onNavigate={()=>{}} onAssetsChanged={()=>{}}>
    <FolderRegistrationContext.Consumer>{tools=><span>{tools ? "분류 도구 있음" : "오리지널 보관"}</span>}</FolderRegistrationContext.Consumer>
  </CharacterFolderContent>);
  expect(screen.getByText("오리지널 보관")).toBeInTheDocument();
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

it("offers single and mixed cleanup from one character organization entry",()=>{
  render(<CharacterFolderOrganizer folderId="child" classifications={fixtureClassifications} targets={[fixtureTarget()]} privacyMode={false} mixedAvailable onClose={()=>{}} onSingleSaved={()=>{}} onMixedFinished={()=>{}}/>);
  expect(screen.getByRole("button",{name:/한 캐릭터 폴더/})).toBeInTheDocument();
  expect(screen.getByRole("button",{name:/여러 캐릭터가 섞인 폴더/})).toBeInTheDocument();
});

it("preselects detected mixed-folder characters and finalizes with the legacy folder name",async()=>{
  const preview={folderId:"mixed",folderName:"카카졸데",seriesId:"series",seriesName:"리버스",totalCount:10,imageCount:10,otherMediaCount:0,childFolderCount:0,unscannedCount:0,pendingCount:0,resolvedCount:8,reviewCount:2,failedCount:0,targetCounts:[{targetId:"kakania",count:7},{targetId:"isolde",count:6}],groupedTargetIds:[]};
  const result={seriesId:"series",groupId:"group",movedImageCount:10,retainedAssetCount:0,folderRemoved:true};
  const api={mixedFolderPreview:vi.fn().mockResolvedValue(preview),queueMixedFolder:vi.fn(),finalizeMixedFolder:vi.fn().mockResolvedValue(result)};
  const finished=vi.fn();
  render(<MixedCharacterFolderMigration folderId="mixed" targets={[fixtureTarget("kakania","카카니아"),fixtureTarget("isolde","이졸데")]} onClose={()=>{}} onFinished={finished} api={api}/>);
  await screen.findByText("카카졸데");
  await waitFor(()=>{
    expect(screen.getByRole("checkbox",{name:/카카니아/})).toBeChecked();
    expect(screen.getByRole("checkbox",{name:/이졸데/})).toBeChecked();
  });
  await userEvent.setup().click(screen.getByRole("button",{name:"그룹으로 정리 완료"}));
  await waitFor(()=>expect(finished).toHaveBeenCalledWith(result));
  expect(api.finalizeMixedFolder).toHaveBeenCalledWith(expect.objectContaining({folderId:"mixed",seriesId:"series",groupName:"카카졸데",targetIds:expect.arrayContaining(["kakania","isolde"])}));
});
