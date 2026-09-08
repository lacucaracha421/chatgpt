import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { useCharacterAutomation, type AutomaticCharacterApi } from "./useCharacterAutomation";
import { createCharacterFixture, fixtureTarget } from "./characterFixtures";
import type { ScanStatus } from "./api";
afterEach(()=>{cleanup();vi.useRealTimers();});
it("coalesces imports and applies only after all owned scans finish",async()=>{
 vi.useFakeTimers();
 const target=fixtureTarget(); let scans:ScanStatus[]=[];
 const api:AutomaticCharacterApi={...createCharacterFixture(),targets:vi.fn().mockResolvedValue([target]),runtime:vi.fn().mockResolvedValue(true),runs:vi.fn(async()=>scans),start:vi.fn(async(id,fingerprint)=>{const scan={id:`scan-${scans.length}`,targetId:id,targetFingerprint:fingerprint,runtimeFingerprint:"runtime",state:"completed",total:1,completed:1,errors:0,cacheHits:0,extractions:1,error:null};scans=[scan];return scan;}),applyAutomatic:vi.fn().mockResolvedValue(1)};
 const changed=vi.fn(); const series=[{classificationId:"series",heroAssetId:null,autoClassify:true}];
 const {rerender}=renderHook(({version})=>useCharacterAutomation([target],series,version,changed,api),{initialProps:{version:0}});
 rerender({version:1});rerender({version:2});
 await act(async()=>{await vi.advanceTimersByTimeAsync(2300);});
 expect(api.start).toHaveBeenCalledTimes(1);
 expect(api.applyAutomatic).toHaveBeenCalledWith(["scan-0"]);
 expect(changed).toHaveBeenCalledTimes(1);
 await act(async()=>{await vi.advanceTimersByTimeAsync(5000);});
 expect(api.start).toHaveBeenCalledTimes(1);
});
it("cancels an owned scan on pause and never auto-approves the partial batch",async()=>{
 vi.useFakeTimers(); const target=fixtureTarget();
 const scan:ScanStatus={id:"scan",targetId:target.id,targetFingerprint:target.fingerprint,runtimeFingerprint:"runtime",state:"running",total:2,completed:0,errors:0,cacheHits:0,extractions:0,error:null};
 let started=false;
 const api:AutomaticCharacterApi={...createCharacterFixture(),targets:async()=>[target],runtime:async()=>true,runs:async()=>started?[scan]:[],start:vi.fn(async()=>{started=true;return scan;}),cancel:vi.fn(async()=>({...scan,state:"cancelled"})),applyAutomatic:vi.fn()};
 const {result}=renderHook(()=>useCharacterAutomation([target],[{classificationId:"series",heroAssetId:null,autoClassify:true}],0,vi.fn(),api));
 await act(async()=>{await vi.advanceTimersByTimeAsync(1700);});
 act(()=>result.current.pause());
 await act(async()=>{await vi.advanceTimersByTimeAsync(1000);});
 expect(api.cancel).toHaveBeenCalledWith("scan"); expect(api.applyAutomatic).not.toHaveBeenCalled();
});
it("publishes completed images while the remaining images are still running",async()=>{
 vi.useFakeTimers(); const target=fixtureTarget();
 const scan:ScanStatus={id:"stream",targetId:target.id,targetFingerprint:target.fingerprint,runtimeFingerprint:"runtime",state:"running",total:20,completed:1,errors:0,cacheHits:0,extractions:1,error:null};
 let started=false;
 const api:AutomaticCharacterApi={...createCharacterFixture(),targets:async()=>[target],runtime:async()=>true,runs:async()=>started?[scan]:[],start:vi.fn(async()=>{started=true;return scan;}),cancel:vi.fn().mockResolvedValue({...scan,state:"cancelled"}),applyAutomatic:vi.fn().mockResolvedValueOnce(1).mockResolvedValue(0)};
 const changed=vi.fn();
 renderHook(()=>useCharacterAutomation([target],[{classificationId:"series",heroAssetId:null,autoClassify:true}],0,changed,api));
 await act(async()=>{await vi.advanceTimersByTimeAsync(2200);});
 expect(api.start).toHaveBeenCalledWith(target.id,target.fingerprint,true);
 expect(api.applyAutomatic).toHaveBeenCalledWith(["stream"]);
 expect(changed).toHaveBeenCalledTimes(1);
});
it("continues with the next character after an individual scan fails",async()=>{
 vi.useFakeTimers(); const a=fixtureTarget(),b={...fixtureTarget(),id:"other",displayName:"Noel"};
 let scans:ScanStatus[]=[];
 const api:AutomaticCharacterApi={...createCharacterFixture(),targets:async()=>[a,b],runtime:async()=>true,runs:async()=>scans,start:vi.fn(async(id,fingerprint)=>{
   if(id===a.id) throw new Error("missing reference");
   const scan:ScanStatus={id:"second",targetId:id,targetFingerprint:fingerprint,runtimeFingerprint:"runtime",state:"completed",total:1,completed:1,errors:0,cacheHits:0,extractions:1,error:null};scans=[scan];return scan;
 }),applyAutomatic:vi.fn().mockResolvedValue(1)};
 const {result}=renderHook(()=>useCharacterAutomation([a,b],[{classificationId:"series",heroAssetId:null,autoClassify:true}],0,vi.fn(),api));
 await act(async()=>{await vi.advanceTimersByTimeAsync(2300);});
 expect(api.start).toHaveBeenCalledTimes(2);
 expect(result.current.message).toContain("1건 확정");
 expect(result.current.message).toContain("missing reference");
});
