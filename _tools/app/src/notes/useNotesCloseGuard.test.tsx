import { cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
const mocks=vi.hoisted(()=>({lock:vi.fn(async()=>{}),quit:vi.fn(),quitHandler:null as null|(()=>Promise<void>),pending:false,flush:vi.fn(),close:vi.fn(),message:vi.fn(),handler:null as null|((e:{preventDefault:()=>void})=>Promise<void>)}));
vi.mock("@tauri-apps/api/core",()=>({isTauri:()=>true,invoke:mocks.quit}));
vi.mock("@tauri-apps/api/event",()=>({listen:async (_name:string, handler:typeof mocks.quitHandler)=>{mocks.quitHandler=handler;return()=>{};}}));
vi.mock("@tauri-apps/api/window",()=>({getCurrentWindow:()=>({close:mocks.close,onCloseRequested:async(handler:typeof mocks.handler)=>{mocks.handler=handler;return()=>{};}})}));
vi.mock("@tauri-apps/plugin-dialog",()=>({message:mocks.message}));
vi.mock("./store",()=>({hasUnsavedNotes:()=>mocks.pending,flushNotes:()=>mocks.flush(),lockAllSecrets:()=>mocks.lock()}));
import {useNotesCloseGuard} from "./useNotesCloseGuard";
function Guard(){useNotesCloseGuard();return null;}
afterEach(()=>{cleanup();vi.clearAllMocks();mocks.handler=null;mocks.quitHandler=null;mocks.pending=false;});
it("defers native closing until pending local edits finish",async()=>{
  mocks.pending=true;mocks.flush.mockImplementation(async()=>{mocks.pending=false;return true;});render(<Guard/>);
  await waitFor(()=>expect(mocks.handler).not.toBeNull());const event={preventDefault:vi.fn()};await mocks.handler!(event);
  expect(event.preventDefault).toHaveBeenCalled();expect(mocks.flush).toHaveBeenCalled();expect(mocks.quit).toHaveBeenCalledWith("workload_close_window");
});
it("always keeps the webview from destroying the window and lets Rust hide to the tray or quit",async()=>{
  render(<Guard/>);
  await waitFor(()=>expect(mocks.handler).not.toBeNull());const event={preventDefault:vi.fn()};await mocks.handler!(event);
  expect(event.preventDefault).toHaveBeenCalledOnce();expect(mocks.flush).not.toHaveBeenCalled();
  expect(mocks.close).not.toHaveBeenCalled();expect(mocks.quit).toHaveBeenCalledWith("workload_close_window");
  // Hiding to the tray locks secret notes first.
  expect(mocks.lock).toHaveBeenCalledOnce();expect(mocks.lock.mock.invocationCallOrder[0]).toBeLessThan(mocks.quit.mock.invocationCallOrder[0]!);
});
it("keeps the window open when local storage fails",async()=>{
  mocks.pending=true;mocks.flush.mockResolvedValue(false);render(<Guard/>);
  await waitFor(()=>expect(mocks.handler).not.toBeNull());const event={preventDefault:vi.fn()};await mocks.handler!(event);
  expect(event.preventDefault).toHaveBeenCalled();expect(mocks.close).not.toHaveBeenCalled();expect(mocks.quit).not.toHaveBeenCalled();expect(mocks.message).toHaveBeenCalledOnce();
});

it("tray quit flushes notes before native exit",async()=>{
  mocks.pending=true;mocks.flush.mockResolvedValue(true);render(<Guard/>);
  await waitFor(()=>expect(mocks.quitHandler).not.toBeNull());await mocks.quitHandler!();
  expect(mocks.flush).toHaveBeenCalledOnce();expect(mocks.quit).toHaveBeenCalledWith("workload_quit");
});
it("tray quit keeps the app alive when notes cannot be saved",async()=>{
  mocks.pending=true;mocks.flush.mockResolvedValue(false);render(<Guard/>);
  await waitFor(()=>expect(mocks.quitHandler).not.toBeNull());await mocks.quitHandler!();
  expect(mocks.quit).not.toHaveBeenCalled();expect(mocks.message).toHaveBeenCalledOnce();
});
