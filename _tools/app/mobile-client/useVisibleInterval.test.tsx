import {act,cleanup,render} from '@testing-library/react';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {useVisibleInterval} from './useVisibleInterval';
import {usePublicationCheck} from './usePublicationCheck';
const mocks=vi.hoisted(()=>({api:vi.fn()}));
vi.mock('./transport',()=>({api:mocks.api}));
let visibility:DocumentVisibilityState;
beforeEach(()=>{vi.useFakeTimers();visibility='visible';vi.spyOn(document,'visibilityState','get').mockImplementation(()=>visibility);mocks.api.mockResolvedValue({revision:'one'});});
afterEach(()=>{cleanup();vi.restoreAllMocks();vi.useRealTimers();mocks.api.mockClear();});
function Intervals({tick}:{tick:()=>void}){useVisibleInterval(tick,1000);useVisibleInterval(tick,2000);return null;}
it('has zero live intervals when hidden, re-arms once, and collapses the two resume signals',()=>{
 const tick=vi.fn();render(<Intervals tick={tick}/>);expect(vi.getTimerCount()).toBe(2);
 visibility='hidden';act(()=>document.dispatchEvent(new Event('visibilitychange')));expect(vi.getTimerCount()).toBe(0);
 act(()=>vi.advanceTimersByTime(60_000));expect(tick).not.toHaveBeenCalled();
 visibility='visible';act(()=>{window.dispatchEvent(new Event('lakomics-resume'));document.dispatchEvent(new Event('visibilitychange'));});
 expect(tick).toHaveBeenCalledTimes(2);expect(vi.getTimerCount()).toBe(2);
 cleanup();expect(vi.getTimerCount()).toBe(0);
});
function Publications(){usePublicationCheck(true,'/v1/library/characters/status','one',()=>{});usePublicationCheck(true,'/v1/library/characters/status','one',()=>{});return null;}
it('shares one characters status request and timer between consumers',async()=>{
 render(<Publications/>);await act(async()=>{});expect(mocks.api).toHaveBeenCalledTimes(1);expect(vi.getTimerCount()).toBe(1);
 await act(()=>vi.advanceTimersByTimeAsync(60_000));expect(mocks.api).toHaveBeenCalledTimes(2);
 visibility='hidden';act(()=>document.dispatchEvent(new Event('visibilitychange')));expect(vi.getTimerCount()).toBe(0);
 await act(()=>vi.advanceTimersByTimeAsync(120_000));expect(mocks.api).toHaveBeenCalledTimes(2);
 expect(mocks.api.mock.calls[0][4]).toBe(true);
});
