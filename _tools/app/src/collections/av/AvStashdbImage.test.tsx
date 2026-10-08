import {act,cleanup,render,waitFor} from "@testing-library/react";
import {afterEach,expect,it,vi} from "vitest";
import {AvStashdbImage} from "./AvStashdbImage";
import type {AvGateway} from "../avTypes";
afterEach(cleanup);
it("serializes relay previews",async()=>{
  let finish:(value:string)=>void=()=>{};
  const preview=vi.fn().mockImplementationOnce(()=>new Promise<string>(resolve=>{finish=resolve;})).mockResolvedValue("data:image/jpeg;base64,AA==");
  const api={previewStashdbImage:preview} as unknown as AvGateway;
  const view=render(<><AvStashdbImage url="/first" routed api={api} onError={vi.fn()}/><AvStashdbImage url="/second" routed api={api} onError={vi.fn()}/></>);
  await waitFor(()=>expect(preview).toHaveBeenCalledTimes(1));await act(async()=>finish("data:image/jpeg;base64,AA=="));await waitFor(()=>expect(preview).toHaveBeenCalledTimes(2));
  expect(preview.mock.calls.map(c=>c[0])).toEqual(["/first","/second"]);view.unmount();
});
