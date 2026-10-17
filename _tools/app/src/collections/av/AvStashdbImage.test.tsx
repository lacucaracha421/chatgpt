import {act,cleanup,render,waitFor} from "@testing-library/react";
import {afterEach,expect,it,vi} from "vitest";
import {AvStashdbImage} from "./AvStashdbImage";
import type {AvGateway} from "../avTypes";
afterEach(cleanup);
it("loads a few relay previews at a time and starts the next as one finishes",async()=>{
  const finish:Array<(value:string)=>void>=[];
  const preview=vi.fn().mockImplementation(()=>new Promise<string>(resolve=>{finish.push(resolve);}));
  const api={previewStashdbImage:preview} as unknown as AvGateway;
  const urls=["/lane-1","/lane-2","/lane-3","/lane-4","/lane-5"];
  const view=render(<>{urls.map(url=><AvStashdbImage key={url} url={url} routed api={api} onError={vi.fn()}/>)}</>);
  await waitFor(()=>expect(preview).toHaveBeenCalledTimes(3));
  await act(async()=>finish[0]("data:image/jpeg;base64,AA=="));await waitFor(()=>expect(preview).toHaveBeenCalledTimes(4));
  await act(async()=>finish[1]("data:image/jpeg;base64,AA=="));await waitFor(()=>expect(preview).toHaveBeenCalledTimes(5));
  expect(preview.mock.calls.map(c=>c[0])).toEqual(urls);
  await act(async()=>finish.slice(2).forEach(done=>done("data:image/jpeg;base64,AA==")));view.unmount();
});
it("shows an already loaded preview at once when the grid is opened again",async()=>{
  const preview=vi.fn().mockResolvedValue("data:image/jpeg;base64,AA==");
  const api={previewStashdbImage:preview} as unknown as AvGateway;
  const first=render(<AvStashdbImage url="/again" routed api={api} onError={vi.fn()}/>);
  await waitFor(()=>expect(first.container.querySelector("img")).not.toBeNull());first.unmount();
  const second=render(<AvStashdbImage url="/again" routed api={api} onError={vi.fn()}/>);
  expect(second.container.querySelector("img")).not.toBeNull();expect(preview).toHaveBeenCalledTimes(1);
});
