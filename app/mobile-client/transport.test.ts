import {afterEach, describe, expect, it, vi} from 'vitest';
import {native} from './transport';
afterEach(() => { delete window.LakomicsNative; vi.useRealTimers(); });
describe('native bridge', () => {
  it('matches replies by request ID and never resolves a cancelled operation', async () => {
    const calls:{id:string;op:string;payload:string}[]=[];
    const cancel=vi.fn(); window.LakomicsNative={request:(id,op,payload)=>{calls.push({id,op,payload});},cancel};
    const controller=new AbortController();
    const old=native('api',{path:'/v1/library/assets'},controller.signal).catch(error=>error.name);
    const current=native('status');
    controller.abort();
    window.dispatchEvent(new CustomEvent('lakomics-native',{detail:{id:calls[0].id,ok:true,data:{wrong:true}}}));
    window.dispatchEvent(new CustomEvent('lakomics-native',{detail:{id:calls[1].id,ok:true,data:{configured:true}}}));
    expect(await old).toBe('AbortError'); expect(await current).toEqual({configured:true}); expect(cancel).toHaveBeenCalledWith(calls[0].id);
  });
  it('cancels timed-out native calls instead of retaining pending closures', async () => {
    vi.useFakeTimers(); const cancel=vi.fn(); window.LakomicsNative={request:()=>{},cancel};
    const promise=native('status').catch(error=>error.message);
    await vi.advanceTimersByTimeAsync(45000); expect(await promise).toContain('초과'); expect(cancel).toHaveBeenCalledOnce();
  });
});
