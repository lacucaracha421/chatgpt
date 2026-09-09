import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { CharacterGroups } from "./CharacterGroups";
import { CharacterConversion } from "./CharacterConversion";
import { fixtureTarget } from "./characterFixtures";
vi.mock("@tauri-apps/api/core",()=>({invoke:vi.fn()}));
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
  await user.click(await screen.findByRole("button",{name:"학생회 · 1명"}));
  expect(screen.getByText("히나 카드")).toBeInTheDocument();
  expect(invoke).toHaveBeenCalledWith("save_character_group",{request:expect.objectContaining({seriesId:"series",targetIds:["hina"],name:"학생회"})});
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
