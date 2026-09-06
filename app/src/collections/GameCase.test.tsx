import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { GameCase } from "./GameCase";
import type { CoverRequest } from "./physical/collectibleRuntime";
import type { Snapshot } from "./physical/RenderCache";
const pending=vi.hoisted(()=>[] as Array<{request:CoverRequest;notify:(value:Snapshot)=>void;release:ReturnType<typeof vi.fn>}>);
vi.mock("./physical/collectibleRuntime",()=>({
  coverKey:(request:CoverRequest)=>JSON.stringify(request),
  acquireCover:(request:CoverRequest,notify:(value:Snapshot)=>void)=>{const release=vi.fn();pending.push({request,notify,release});return release;},
}));
vi.mock("./physical/coverVisibility",()=>({observeCover:(_element:unknown,notify:(value:boolean)=>void)=>{notify(true);return()=>undefined;},observeCoverSize:()=>()=>undefined}));
afterEach(()=>{cleanup();pending.length=0;vi.clearAllMocks();});
it("uses shared snapshots without creating a canvas for every case",()=>{
  const view=render(<GameCase src="first.jpg" alt="게임 표지" />);
  expect(view.container.querySelector("canvas")).toBeNull();
  act(()=>pending.find(job=>job.request.src==="")!.notify({url:"blob:shell",width:256,height:362}));
  expect(screen.getByRole("img")).toHaveAttribute("src","blob:shell");
  const obsolete=pending.find(job=>job.request.src==="first.jpg")!;
  view.rerender(<GameCase src="second.jpg" alt="게임 표지" />);
  expect(obsolete.release).toHaveBeenCalledOnce();
  act(()=>obsolete.notify({url:"blob:obsolete",width:256,height:362}));
  expect(screen.getByRole("img")).not.toHaveAttribute("src","blob:obsolete");
  act(()=>pending.find(job=>job.request.src==="second.jpg")!.notify({url:"blob:current",width:256,height:362}));
  expect(screen.getByRole("img")).toHaveAttribute("src","blob:current");
});
it("releases the raster subscription on unmount and forwards revision scope",()=>{
  const view=render(<GameCase src="cover.jpg" alt="게임" scope="library-a" revision="2" />);
  const job=pending.find(item=>item.request.src==="cover.jpg")!;
  expect(job.request.scope).toBe("library-a");expect(job.request.revision).toBe("2");view.unmount();expect(job.release).toHaveBeenCalledOnce();
});
