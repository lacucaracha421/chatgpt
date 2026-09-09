import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { useCharacterAutomation, type AutomaticCharacterApi, type IncrementalStatus } from "./useCharacterAutomation";
afterEach(() => { cleanup(); vi.useRealTimers(); });
const idle: IncrementalStatus = { running: true, paused: false, pending: 0, completed: 0, confirmed: 0, activeAssetId: null, total: 0, compared: 0, error: null };
it("refresh and target changes never launch target scans or create native work", async () => {
 vi.useFakeTimers();
 const api: AutomaticCharacterApi = {status: vi.fn().mockResolvedValue(idle),pause:vi.fn().mockResolvedValue(undefined)};
 const changed = vi.fn();
 const { rerender } = renderHook(() => useCharacterAutomation(changed,api),{initialProps:{version:0}});
 await act(async()=>{await vi.advanceTimersByTimeAsync(100);});
 rerender({version:1});rerender({version:20});
 await act(async()=>{await vi.advanceTimersByTimeAsync(3000);});
 expect(api.pause).not.toHaveBeenCalled();expect(changed).not.toHaveBeenCalled();
});
it("publishes one refresh per durable completion and does not cancel on navigation", async () => {
 vi.useFakeTimers();let state=idle;
 const api:AutomaticCharacterApi={status:vi.fn(async()=>state),pause:vi.fn().mockResolvedValue(undefined)};
 const changed=vi.fn();const {unmount}=renderHook(()=>useCharacterAutomation(changed,api));
 await act(async()=>{await vi.advanceTimersByTimeAsync(100);});
 state={...idle,completed:1,confirmed:1};
 await act(async()=>{await vi.advanceTimersByTimeAsync(3000);});
 expect(changed).toHaveBeenCalledTimes(1);unmount();expect(api.pause).not.toHaveBeenCalled();
});
it("pause and resume control the native queue without renderer-owned scans",async()=>{
 vi.useFakeTimers();const api:AutomaticCharacterApi={status:vi.fn().mockResolvedValue({...idle,paused:true}),pause:vi.fn().mockResolvedValue(undefined)};
 const {result}=renderHook(()=>useCharacterAutomation(vi.fn(),api));
 await act(async()=>{await vi.advanceTimersByTimeAsync(100);});expect(result.current.paused).toBe(true);
 await act(async()=>result.current.resume());expect(api.pause).toHaveBeenCalledWith(false);
 await act(async()=>result.current.pause());expect(api.pause).toHaveBeenCalledWith(true);
});
