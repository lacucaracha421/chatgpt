import {act, cleanup, fireEvent, render, screen, waitFor} from '@testing-library/react';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import type {Asset} from './types';
// Radix's dialog focus/escape machinery schedules work outside `fireEvent`, so the
// environment must advertise `act` support for those updates to be flushed.
(globalThis as {IS_REACT_ACT_ENVIRONMENT?: boolean}).IS_REACT_ACT_ENVIRONMENT = true;
const mocks=vi.hoisted(()=>({ticket:vi.fn(),decode:vi.fn(),info:vi.fn()}));
vi.mock('./media',()=>({mediaTicket:mocks.ticket,decodeImage:mocks.decode,invalidateTicket:vi.fn()}));
vi.mock('./AlbumMembershipEditor',()=>({AlbumMembershipEditor:({open}:{open:boolean})=>open?<div>album-editor-open</div>:null}));
vi.mock('./ClassificationAssignmentEditor',()=>({ClassificationAssignmentEditor:({open}:{open:boolean})=>open?<div>classification-editor-open</div>:null}));
vi.mock('./ViewerInfo',()=>({ViewerInfo:(props:{asset:Asset;mediaError:string;onClose():void})=>{mocks.info(props);return <div>viewer-info-open<button aria-label="정보 닫기" onClick={props.onClose}/></div>;}}));
import {Viewer} from './Viewer';
const items:Asset[]=[{id:'a',kind:'image',preview:'https://test.invalid/thumb-a',creator_name:'A'},{id:'b',kind:'image',preview:'https://test.invalid/thumb-b',creator_name:'B'}];
afterEach(cleanup);
beforeEach(()=>{mocks.ticket.mockReset();mocks.decode.mockReset();mocks.info.mockReset();mocks.ticket.mockImplementation((asset:Asset)=>Promise.resolve({url:`https://test.invalid/original-${asset.id}`}));});
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
  it('swipes across video content while keeping the native control strip usable',async()=>{
    const change=vi.fn();render(<Viewer items={[{id:'v',kind:'video'},items[1]]} index={0} onIndex={change} onClose={()=>{}}/>);
    await waitFor(()=>expect(document.querySelector('video')?.getAttribute('src')).toContain('original-v'));
    const player=document.querySelector('video')!,surface=document.querySelector('.viewer-surface')!;
    vi.spyOn(player,'getBoundingClientRect').mockReturnValue({left:0,top:0,right:800,bottom:600,width:800,height:600,x:0,y:0,toJSON:()=>({})});
    fireEvent.pointerDown(surface,{pointerId:1,button:0,clientX:600,clientY:300});fireEvent.pointerUp(surface,{pointerId:1,clientX:200,clientY:300});expect(change).toHaveBeenCalledWith(1);
    change.mockClear();fireEvent.pointerDown(player,{pointerId:2,button:0,clientX:600,clientY:570});fireEvent.pointerUp(player,{pointerId:2,clientX:200,clientY:570});expect(change).not.toHaveBeenCalled();
  });
  it('requests the next asset page when approaching the loaded end',()=>{
    const more=vi.fn();render(<Viewer items={items} index={1} onIndex={()=>{}} onClose={()=>{}} onNearEnd={more}/>);expect(more).toHaveBeenCalledOnce();
  });
  it('opens the Album membership editor from the viewer chrome',()=>{
    render(<Viewer items={[items[0]]} index={0} onIndex={()=>{}} onClose={()=>{}}/>);
    fireEvent.click(screen.getByRole('button',{name:'앨범'}));
    expect(screen.getByText('album-editor-open')).toBeTruthy();
  });
  it('exposes a 분류 action that opens the Classification picker',()=>{
    render(<Viewer items={[items[0]]} index={0} onIndex={()=>{}} onClose={()=>{}}/>);
    expect(screen.queryByText('classification-editor-open')).toBeNull();
    fireEvent.click(screen.getByRole('button',{name:'분류'}));
    expect(screen.getByText('classification-editor-open')).toBeTruthy();
  });
  // The three Viewer overlays are mutually exclusive: opening one closes the others.
  it('keeps 분류, 앨범 and 정보 mutually exclusive',()=>{
    render(<Viewer items={items} index={0} onIndex={()=>{}} onClose={()=>{}}/>);
    fireEvent.click(screen.getByRole('button',{name:'분류'}));
    fireEvent.click(screen.getByRole('button',{name:'앨범'}));
    expect(screen.getByText('album-editor-open')).toBeTruthy();
    expect(screen.queryByText('classification-editor-open')).toBeNull();
    // The information panel is a nested modal, so once it is open Radix hides the
    // viewer chrome from the accessibility tree; `hidden:true` reads the real DOM.
    fireEvent.click(screen.getByRole('button',{name:'미디어 정보'}));
    expect(screen.queryByText('album-editor-open')).toBeNull();
    expect(screen.getByText('viewer-info-open')).toBeTruthy();
    fireEvent.click(screen.getByRole('button',{name:'분류',hidden:true}));
    expect(screen.queryByText('viewer-info-open')).toBeNull();
    expect(screen.getByText('classification-editor-open')).toBeTruthy();
    expect(screen.queryByText('album-editor-open')).toBeNull();
  });
  it('does not swipe to another Asset while the Classification picker is open',()=>{
    const change=vi.fn();
    render(<Viewer items={items} index={0} onIndex={change} onClose={()=>{}}/>);
    fireEvent.click(screen.getByRole('button',{name:'분류'}));
    const surface=document.querySelector('.viewer-surface')!;
    fireEvent.pointerDown(surface,{pointerId:1,button:0,clientX:600,clientY:300});
    fireEvent.pointerUp(surface,{pointerId:1,clientX:200,clientY:300});
    expect(change).not.toHaveBeenCalled();
  });
  it('resets a stale Classification picker when the Asset changes',async()=>{
    const {rerender}=render(<Viewer items={items} index={0} onIndex={()=>{}} onClose={()=>{}}/>);
    fireEvent.click(screen.getByRole('button',{name:'분류'}));
    expect(screen.getByText('classification-editor-open')).toBeTruthy();
    rerender(<Viewer items={items} index={1} onIndex={()=>{}} onClose={()=>{}}/>);
    await waitFor(()=>expect(screen.queryByText('classification-editor-open')).toBeNull());
  });
  it('native video control gestures cannot navigate the gallery',async()=>{
    const change=vi.fn(); const {container}=render(<Viewer items={[{id:'v',kind:'video'},items[1]]} index={0} onIndex={change} onClose={()=>{}}/>);
    const surface=container.ownerDocument.querySelector('.viewer-surface')!;
    fireEvent.pointerDown(surface,{pointerId:1,clientX:200,clientY:100}); fireEvent.pointerUp(surface,{pointerId:1,clientX:20,clientY:100});
    expect(change).not.toHaveBeenCalled();
    await waitFor(()=>expect(container.ownerDocument.querySelector('video')?.getAttribute('src')).toContain('original-v'));
  });
  it('opens the information panel in its own dialog with a labelled close control',()=>{
    render(<Viewer items={items} index={0} onIndex={()=>{}} onClose={()=>{}}/>);
    expect(screen.queryByText('viewer-info-open')).toBeNull();
    fireEvent.click(screen.getByRole('button',{name:'미디어 정보'}));
    expect(screen.getByText('viewer-info-open')).toBeTruthy();
    // The panel is presented in the shared Dialog as its own labelled modal.
    const panel=screen.getByRole('dialog',{name:'미디어 정보'});
    expect(panel.className).toContain('ui-dialog');
    expect(panel.contains(screen.getByText('viewer-info-open'))).toBe(true);
    expect(screen.getByRole('button',{name:'정보 닫기'})).toBeTruthy();
  });
  it('closes the information panel through its own close control',()=>{
    render(<Viewer items={items} index={0} onIndex={()=>{}} onClose={()=>{}}/>);
    fireEvent.click(screen.getByRole('button',{name:'미디어 정보'}));
    const panel=screen.getByRole('dialog',{name:'미디어 정보'});
    const close=screen.getByRole('button',{name:'정보 닫기'});
    act(() => close.click());
    expect(panel.contains(close)).toBe(true);
    // The panel dialog stays mounted (its exit transition is running) but no longer
    // contains the panel body, and the viewer is untouched.
    expect(screen.queryByText('viewer-info-open')).toBeNull();
    expect(screen.getByRole('dialog',{name:'미디어 감상'})).toBeTruthy();
  });
  it('dismisses the information panel before the viewer on Escape',()=>{
    const close=vi.fn();
    render(<Viewer items={items} index={0} onIndex={()=>{}} onClose={close}/>);
    fireEvent.click(screen.getByRole('button',{name:'미디어 정보'}));
    // Escape reaches the topmost dialog first: the panel closes and the viewer survives.
    fireEvent.keyDown(screen.getByRole('dialog',{name:'미디어 정보'}),{key:'Escape'});
    expect(screen.queryByText('viewer-info-open')).toBeNull();
    expect(close).not.toHaveBeenCalled();
  });
  it('takes Android Back for the information panel before the viewer',async()=>{
    // `App` owns the only `lakomics-back` listener and calls this ref before closing the
    // viewer, mirroring `albumsBack`. The ref must consume Back exactly while the panel
    // is open, so the viewer's own dismissal stays reachable.
    const backRef:{current: (()=>boolean)|null} = {current:null};
    const close=vi.fn();
    render(<Viewer items={items} index={0} onIndex={()=>{}} onClose={close} backRef={backRef}/>);
    expect(backRef.current).toBeTypeOf('function');
    // Nothing to consume while no panel is open, so the viewer's Back still runs.
    let consumed = true;
    act(() => {consumed = backRef.current!();});
    expect(consumed).toBe(false);
    fireEvent.click(screen.getByRole('button',{name:'미디어 정보'}));
    expect(screen.getByText('viewer-info-open')).toBeTruthy();
    act(() => {consumed = backRef.current!();});
    expect(consumed).toBe(true);
    expect(screen.queryByText('viewer-info-open')).toBeNull();
    expect(close).not.toHaveBeenCalled();
    // The panel is gone, so the next Back belongs to the viewer again.
    act(() => {consumed = backRef.current!();});
    expect(consumed).toBe(false);
  });
  it('stops consuming Back once the viewer unmounts',async()=>{
    const backRef:{current: (()=>boolean)|null} = {current:null};
    const {unmount}=render(<Viewer items={items} index={0} onIndex={()=>{}} onClose={()=>{}} backRef={backRef}/>);
    expect(backRef.current).toBeTypeOf('function');
    unmount();
    expect(backRef.current).toBeNull();
  });
  it('toggles the information panel while keeping the media surface intact',()=>{
    render(<Viewer items={items} index={0} onIndex={()=>{}} onClose={()=>{}}/>);
    const surface=document.querySelector('.viewer-surface')!;
    fireEvent.click(screen.getByRole('button',{name:'미디어 정보'}));
    fireEvent.keyDown(screen.getByRole('dialog',{name:'미디어 정보'}),{key:'Escape'});
    expect(screen.queryByText('viewer-info-open')).toBeNull();
    fireEvent.click(screen.getByRole('button',{name:'미디어 정보'}));
    expect(screen.getByText('viewer-info-open')).toBeTruthy();
    expect(document.querySelector('.viewer-surface')).toBe(surface);
  });
  it('does not change the gallery sequence for arrow keys used inside the information panel',()=>{
    const change=vi.fn();
    render(<Viewer items={items} index={0} onIndex={change} onClose={()=>{}}/>);
    fireEvent.click(screen.getByRole('button',{name:'미디어 정보'}));
    fireEvent.keyDown(screen.getByText('viewer-info-open'),{key:'ArrowRight'});
    fireEvent.keyDown(screen.getByText('viewer-info-open'),{key:'ArrowLeft'});
    expect(change).not.toHaveBeenCalled();
    // The panel still owns the keyboard and is still open.
    expect(screen.getByRole('dialog').contains(screen.getByText('viewer-info-open'))).toBe(true);
  });
  it('still changes the gallery sequence with arrow keys when no panel is open',()=>{
    const change=vi.fn();
    render(<Viewer items={items} index={0} onIndex={change} onClose={()=>{}}/>);
    fireEvent.keyDown(screen.getByRole('dialog'),{key:'ArrowRight'});
    expect(change).toHaveBeenCalledWith(1);
  });
  it('keeps the media surface gesture rule unchanged while the information panel is open',()=>{
    // The panel owns keyboard input only. A swipe that starts on the media surface
    // (not on the panel) still runs the existing fitted-scale rule, which declines a
    // swipe while an overlay is open — so this must not silently start navigating.
    const change=vi.fn();
    render(<Viewer items={items} index={0} onIndex={change} onClose={()=>{}}/>);
    fireEvent.click(screen.getByRole('button',{name:'미디어 정보'}));
    const surface=document.querySelector('.viewer-surface')!;
    fireEvent.pointerDown(surface,{pointerId:1,button:0,clientX:600,clientY:300});
    fireEvent.pointerUp(surface,{pointerId:1,clientX:200,clientY:300});
    expect(change).not.toHaveBeenCalled();
  });
});
