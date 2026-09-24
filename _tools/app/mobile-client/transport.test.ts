import {afterEach, describe, expect, it, vi} from 'vitest';
import {api,native} from './transport';
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
  it('routes conditional reads through native and settles lifecycle cancellation immediately',async()=>{
    vi.useFakeTimers();let id='',payload='';
    window.LakomicsNative={request:(next,_op,value)=>{id=next;payload=value;},cancel:vi.fn()};
    const response=api('/v1/mobile-catalog/status',undefined,undefined,'GET',true).catch(error=>error.name);
    expect(JSON.parse(payload)).toMatchObject({method:'GET',conditional:true});
    window.dispatchEvent(new CustomEvent('lakomics-native',{detail:{id,ok:false,cancelled:true}}));
    expect(await response).toBe('AbortError');expect(vi.getTimerCount()).toBe(0);
  });

  it('reissues an interrupted live media read once on resume, with no hidden timer or request',async()=>{
    vi.useFakeTimers();const calls:{id:string;op:string}[]=[];
    window.LakomicsNative={request:(id,op)=>calls.push({id,op}),cancel:vi.fn()};
    const controller=new AbortController();
    const response=native('media',{assetId:'a'},controller.signal);
    window.dispatchEvent(new Event('lakomics-pause'));
    window.dispatchEvent(new CustomEvent('lakomics-native',{detail:{id:calls[0].id,ok:false,cancelled:true}}));
    expect(vi.getTimerCount()).toBe(0);await vi.advanceTimersByTimeAsync(60_000);expect(calls).toHaveLength(1);
    window.dispatchEvent(new Event('lakomics-resume'));document.dispatchEvent(new Event('visibilitychange'));
    expect(calls).toHaveLength(2);
    window.dispatchEvent(new CustomEvent('lakomics-native',{detail:{id:calls[1].id,ok:true,data:{url:'cached'}}}));
    expect(await response).toEqual({url:'cached'});expect(vi.getTimerCount()).toBe(0);
  });
  it('does not revive a media read whose owner left while it was backgrounded',async()=>{
    vi.useFakeTimers();let id='';const request=vi.fn((next:string)=>{id=next;});
    window.LakomicsNative={request,cancel:vi.fn()};const controller=new AbortController();
    const response=native('thumbnail',{assetId:'a'},controller.signal).catch(error=>error.name);
    window.dispatchEvent(new Event('lakomics-pause'));
    window.dispatchEvent(new CustomEvent('lakomics-native',{detail:{id,ok:false,cancelled:true}}));
    controller.abort();expect(await response).toBe('AbortError');
    window.dispatchEvent(new Event('lakomics-resume'));expect(request).toHaveBeenCalledTimes(1);expect(vi.getTimerCount()).toBe(0);
  });

});
