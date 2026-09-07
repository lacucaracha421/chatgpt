import { cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
const mocks=vi.hoisted(()=>({pending:false,flush:vi.fn(),close:vi.fn(),message:vi.fn(),handler:null as null|((e:{preventDefault:()=>void})=>Promise<void>)}));
vi.mock("@tauri-apps/api/core",()=>({isTauri:()=>true}));
vi.mock("@tauri-apps/api/window",()=>({getCurrentWindow:()=>({close:mocks.close,onCloseRequested:async(handler:typeof mocks.handler)=>{mocks.handler=handler;return()=>{};}})}));
vi.mock("@tauri-apps/plugin-dialog",()=>({message:mocks.message}));
vi.mock("./store",()=>({hasUnsavedNotes:()=>mocks.pending,flushNotes:()=>mocks.flush()}));
import {useNotesCloseGuard} from "./useNotesCloseGuard";
function Guard(){useNotesCloseGuard();return null;}
afterEach(()=>{cleanup();vi.clearAllMocks();mocks.handler=null;mocks.pending=false;});
it("defers native closing until pending local edits finish",async()=>{
  mocks.pending=true;mocks.flush.mockImplementation(async()=>{mocks.pending=false;return true;});render(<Guard/>);
  await waitFor(()=>expect(mocks.handler).not.toBeNull());const event={preventDefault:vi.fn()};await mocks.handler!(event);
  expect(event.preventDefault).toHaveBeenCalled();expect(mocks.flush).toHaveBeenCalled();expect(mocks.close).toHaveBeenCalledOnce();
});
it("keeps the window open when local storage fails",async()=>{
  mocks.pending=true;mocks.flush.mockResolvedValue(false);render(<Guard/>);
  await waitFor(()=>expect(mocks.handler).not.toBeNull());const event={preventDefault:vi.fn()};await mocks.handler!(event);
  expect(event.preventDefault).toHaveBeenCalled();expect(mocks.close).not.toHaveBeenCalled();expect(mocks.message).toHaveBeenCalledOnce();
});
