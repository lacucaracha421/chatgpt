import {cleanup, fireEvent, render, screen} from '@testing-library/react';
import {afterEach, expect, it, vi} from 'vitest';
const native=vi.hoisted(()=>vi.fn());
vi.mock('./transport',()=>({native,errorText:()=> '캐시를 지우지 못했습니다.'}));
import {Settings} from './Settings';
afterEach(()=>{cleanup();native.mockReset();});
it('shows device cache usage and clears only through its own action',async()=>{
  const cleared=vi.fn();
  native.mockImplementation(async(op:string)=>({bytes:op==='clearCache'?0:2*1024*1024,count:op==='clearCache'?0:12,limit:1024*1024*1024}));
  render(<Settings status={{configured:true,endpoint:'https://example.invalid'}} onStatus={vi.fn()} onClose={vi.fn()} onCacheCleared={cleared}/>);
  await screen.findByText('2.0 MB / 1 GB · 12개');
  expect(cleared).not.toHaveBeenCalled();fireEvent.click(screen.getByRole('button',{name:'캐시 지우기'}));
  await screen.findByText('0.0 MB / 1 GB · 0개');expect(cleared).toHaveBeenCalledOnce();
});
