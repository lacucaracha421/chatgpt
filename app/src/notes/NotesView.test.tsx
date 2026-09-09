import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { WorkspaceChromeProvider, ChromeTarget } from "../layout/WorkspaceChrome";
import { NotesWorkspace } from "./NotesView";
import { NotesStore, type NotesRequest, type Note } from "./store";
afterEach(cleanup);
function surface(store:NotesStore){return render(<WorkspaceChromeProvider scope="notes"><ChromeTarget name="navigation"/><ChromeTarget name="actions"/><ChromeTarget name="search"/><NotesWorkspace store={store}/></WorkspaceChromeProvider>);}
it("creates, edits, pins, trashes and restores through the actual notes editor",async()=>{
  let notes:Note[]=[];
  const request=(async(op:string,input:any)=>{
    if(op==="save"){const note={...input,createdAt:"2026-09-07T00:00:00Z",updatedAt:"2026-09-07T00:00:00Z",localRevision:input.expectedRevision+1,pending:true,conflict:false};notes=[note,...notes.filter(n=>n.id!==note.id)];return note;}
    return{unlocked:true,notes,lastSyncedAt:null};
  }) as NotesRequest;
  const store=new NotesStore(request);surface(store);
  await userEvent.click(await screen.findByRole("button",{name:"새 메모"}));
  fireEvent.change(screen.getByRole("textbox",{name:"메모 제목"}),{target:{value:"읽을 책"}});
  fireEvent.change(screen.getByRole("textbox",{name:"메모 본문"}),{target:{value:"내일 2장 읽기"}});
  await waitFor(()=>expect(store.snapshot().saving).toBe(false));
  await userEvent.click(screen.getByRole("button",{name:"메모 고정"}));
  await waitFor(()=>expect(store.snapshot().notes[0].pinned).toBe(true));
  await userEvent.click(screen.getByRole("button",{name:"메모를 휴지통으로"}));
  await userEvent.click(screen.getByRole("button",{name:"휴지통"}));
  await userEvent.click(screen.getByRole("button",{name:/읽을 책.*내일 2장 읽기/}));
  expect(screen.getByRole("textbox",{name:"메모 본문"})).toHaveAttribute("readonly");
  await userEvent.click(screen.getByRole("button",{name:"복원"}));
  await waitFor(()=>expect(store.snapshot().saving).toBe(false));
  expect(store.snapshot().notes[0]).toMatchObject({title:"읽을 책",body:"내일 2장 읽기",deleted:false,pinned:true});
});
it("requires backing up a newly generated key before unlocking",async()=>{
  const operations:string[]=[];
  const store=new NotesStore((async(op:string)=>{operations.push(op);if(op==="generateKey")return{key:"a".repeat(64)};return{unlocked:op==="unlock",notes:[],lastSyncedAt:null};}) as NotesRequest);
  surface(store);await userEvent.click(await screen.findByRole("button",{name:"처음 사용 · 키 만들기"}));
  const open=screen.getByRole("button",{name:"메모 열기"});expect(open).toBeDisabled();
  await userEvent.click(screen.getByRole("checkbox",{name:"복구키를 안전한 곳에 보관했습니다"}));
  await userEvent.click(open);expect(operations).toContain("unlock");
});

it("keeps typing status stable without delaying local writes",async()=>{
  const note:Note={id:"n",title:"Draft",body:"",pinned:false,deleted:false,createdAt:"2026-09-07T00:00:00Z",updatedAt:"2026-09-07T00:00:00Z",localRevision:0,pending:false,conflict:false};
  const request=vi.fn(async(op:string,input:any)=>op==="save"?{...note,...input,localRevision:1,pending:true}:{unlocked:true,notes:[note],lastSyncedAt:null});
  const store=new NotesStore(request as NotesRequest);surface(store);
  await userEvent.click(await screen.findByRole("button",{name:/Draft/}));
  vi.useFakeTimers();
  try {
    fireEvent.change(screen.getByRole("textbox",{name:"메모 본문"}),{target:{value:"typing"}});
    await act(async()=>{await Promise.resolve();});
    expect(request).toHaveBeenCalledWith("save",expect.objectContaining({body:"typing"}));
    expect(screen.getByText("편집 중 · 자동 저장")).toBeInTheDocument();
    await act(async()=>{vi.advanceTimersByTime(1200);});
    expect(screen.getByText("PC에 저장됨 · 동기화 대기")).toBeInTheDocument();
  } finally { vi.useRealTimers(); }
});
