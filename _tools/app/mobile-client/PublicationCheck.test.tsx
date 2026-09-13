import {act,cleanup,render} from '@testing-library/react';
import {afterEach,it,expect,vi} from 'vitest';
import {usePublicationCheck} from './usePublicationCheck';
const mock=vi.hoisted(()=>({api:vi.fn()}));vi.mock('./transport',()=>({api:mock.api}));
afterEach(()=>{cleanup();vi.useRealTimers();});
it('checks revisions without refetching unchanged content and pauses while reading',async()=>{
 vi.useFakeTimers();mock.api.mockResolvedValue({revision:'a'});const change=vi.fn();
 function View({active}:{active:boolean}){usePublicationCheck(active,'/v1/collections/status','a',change);return null;}
 const view=render(<View active/>);await act(async()=>{});expect(change).not.toHaveBeenCalled();
 mock.api.mockResolvedValue({revision:'b'});await act(async()=>vi.advanceTimersByTime(60000));expect(change).toHaveBeenCalledOnce();
 view.rerender(<View active={false}/>);await act(async()=>vi.advanceTimersByTime(120000));expect(change).toHaveBeenCalledOnce();
});
