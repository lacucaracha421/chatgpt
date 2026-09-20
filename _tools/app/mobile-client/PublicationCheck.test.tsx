import {act,cleanup,render} from '@testing-library/react';
import {afterEach,it,expect,vi} from 'vitest';
import {usePublicationCheck} from './usePublicationCheck';
const mock=vi.hoisted(()=>({api:vi.fn()}));vi.mock('./transport',()=>({api:mock.api}));
afterEach(()=>{cleanup();vi.useRealTimers();mock.api.mockReset();});
it('checks revisions without refetching unchanged content and pauses while reading',async()=>{
 vi.useFakeTimers();mock.api.mockResolvedValue({revision:'a'});const change=vi.fn();
 function View({active}:{active:boolean}){usePublicationCheck(active,'/v1/collections/status','a',(_reply,changed)=>{if(changed)change();});return null;}
 const view=render(<View active/>);await act(async()=>{});expect(change).not.toHaveBeenCalled();
 mock.api.mockResolvedValue({revision:'b'});await act(async()=>vi.advanceTimersByTime(60000));expect(change).toHaveBeenCalledOnce();
 view.rerender(<View active={false}/>);await act(async()=>vi.advanceTimersByTime(120000));expect(change).toHaveBeenCalledOnce();
});
it('reports failure and permits an explicit retry without adding a second poller',async()=>{
 const failure=vi.fn(),change=vi.fn();mock.api.mockRejectedValueOnce(new Error('offline')).mockResolvedValue({publicationRevision:'a'});
 function View({retryKey}:{retryKey:number}){usePublicationCheck(true,'/status',undefined,change,60000,{onError:failure,retryKey});return null;}
 const view=render(<View retryKey={0}/>);await act(async()=>{});
 expect(failure).toHaveBeenCalledOnce();expect(change).not.toHaveBeenCalled();
 view.rerender(<View retryKey={1}/>);await act(async()=>{});
 expect(change).toHaveBeenCalledWith({publicationRevision:'a'},false);expect(mock.api).toHaveBeenCalledTimes(2);
});
it('does not report late failures after pausing',async()=>{
 const pending=Promise.withResolvers<unknown>(),failure=vi.fn();mock.api.mockReturnValue(pending.promise);
 function View({active}:{active:boolean}){usePublicationCheck(active,'/status',undefined,()=>{},60000,{onError:failure});return null;}
 const view=render(<View active/>);view.rerender(<View active={false}/>);
 await act(async()=>pending.reject(new Error('late')));expect(failure).not.toHaveBeenCalled();
});
