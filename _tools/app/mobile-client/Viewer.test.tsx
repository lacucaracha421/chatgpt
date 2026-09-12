import {cleanup, fireEvent, render, screen, waitFor} from '@testing-library/react';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import type {Asset} from './types';
const mocks=vi.hoisted(()=>({ticket:vi.fn(),decode:vi.fn()}));
vi.mock('./media',()=>({mediaTicket:mocks.ticket,decodeImage:mocks.decode,invalidateTicket:vi.fn()}));
import {Viewer} from './Viewer';
const items:Asset[]=[{id:'a',kind:'image',preview:'https://test.invalid/thumb-a',creator_name:'A'},{id:'b',kind:'image',preview:'https://test.invalid/thumb-b',creator_name:'B'}];
afterEach(cleanup);
beforeEach(()=>{mocks.ticket.mockReset();mocks.decode.mockReset();mocks.ticket.mockImplementation((asset:Asset)=>Promise.resolve({url:`https://test.invalid/original-${asset.id}`}));});
describe('progressive viewer',()=>{
  it('cancels the native original request when leaving the viewer',async()=>{
    mocks.ticket.mockImplementation(()=>new Promise(()=>{}));
    const {unmount}=render(<Viewer items={[items[0]]} index={0} onIndex={()=>{}} onClose={()=>{}}/>);
    await waitFor(()=>expect(mocks.ticket).toHaveBeenCalledOnce());
    const signal=mocks.ticket.mock.calls[0][2] as AbortSignal;expect(signal.aborted).toBe(false);
    unmount();expect(signal.aborted).toBe(true);
  });
  it('autoplays and loops videos by default',async()=>{
    render(<Viewer items={[{id:'v',kind:'video'}]} index={0} onIndex={()=>{}} onClose={()=>{}}/>);
    await waitFor(()=>expect(document.querySelector('video')?.getAttribute('src')??'').toContain('original-v'));
    const player=document.querySelector('video')!;expect(player.autoplay).toBe(true);expect(player.loop).toBe(true);expect(player.preload).toBe('auto');
  });
  it('renews a failed video and restores its playback position',async()=>{
    render(<Viewer items={[{id:'v',kind:'video'}]} index={0} onIndex={()=>{}} onClose={()=>{}}/>);
    await waitFor(()=>expect(document.querySelector('video')?.getAttribute('src')).toContain('original-v'));
    const previous=document.querySelector('video')!;previous.currentTime=25;fireEvent.error(previous);
    fireEvent.click(await screen.findByRole('button',{name:'다시 시도'}));
    await waitFor(()=>expect(mocks.ticket).toHaveBeenCalledTimes(2));
    const next=document.querySelector('video')!;expect(next).not.toBe(previous);fireEvent.loadedMetadata(next);expect(next.currentTime).toBe(25);
  });
  it('retains the thumbnail until original decoding completes',async()=>{
    let finish!:()=>void; mocks.decode.mockImplementation(()=>new Promise<void>(resolve=>{finish=resolve;}));
    render(<Viewer items={[items[0]]} index={0} onIndex={()=>{}} onClose={()=>{}}/>);
    expect(screen.getByRole('img').getAttribute('src')).toBe(items[0].preview);
    await waitFor(()=>expect(mocks.decode).toHaveBeenCalledOnce());
    expect(screen.getByRole('img').getAttribute('src')).toBe(items[0].preview);
    finish(); await waitFor(()=>expect(screen.getByRole('img').getAttribute('src')).toContain('original-a'));
  });
  it('keeps the useful thumbnail and offers retry on decode failure',async()=>{
    mocks.decode.mockRejectedValue(new Error('이미지를 표시하지 못했습니다.'));
    render(<Viewer items={[items[0]]} index={0} onIndex={()=>{}} onClose={()=>{}}/>);
    await screen.findByText('이미지를 표시하지 못했습니다.'); expect(screen.getByRole('img').getAttribute('src')).toBe(items[0].preview);
    expect(screen.getByRole('button',{name:'다시 시도'})).toBeTruthy();
  });
  it('does not replace B with a late original for A',async()=>{
    let finishA!:()=>void; mocks.decode.mockImplementation((url:string)=>url.endsWith('a')?new Promise<void>(resolve=>{finishA=resolve;}):Promise.resolve());
    const {rerender}=render(<Viewer items={items} index={0} onIndex={()=>{}} onClose={()=>{}}/>);
    await waitFor(()=>expect(mocks.decode).toHaveBeenCalled());
    rerender(<Viewer items={items} index={1} onIndex={()=>{}} onClose={()=>{}}/>);
    await waitFor(()=>expect(screen.getByRole('img').getAttribute('src')).toContain('original-b'));
    finishA(); expect(screen.getByRole('img').getAttribute('src')).toContain('original-b');
  });
  it('native video control gestures cannot navigate the gallery',async()=>{
    const change=vi.fn(); const {container}=render(<Viewer items={[{id:'v',kind:'video'},items[1]]} index={0} onIndex={change} onClose={()=>{}}/>);
    const surface=container.ownerDocument.querySelector('.viewer-surface')!;
    fireEvent.pointerDown(surface,{pointerId:1,clientX:200,clientY:100}); fireEvent.pointerUp(surface,{pointerId:1,clientX:20,clientY:100});
    expect(change).not.toHaveBeenCalled();
    await waitFor(()=>expect(container.ownerDocument.querySelector('video')?.getAttribute('src')).toContain('original-v'));
  });
});
