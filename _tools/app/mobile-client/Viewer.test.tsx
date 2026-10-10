import {act, cleanup, fireEvent, render, screen, waitFor} from '@testing-library/react';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import type {Asset} from './types';
import {resetPerfEnabledForTests} from './perfEnabled';
import {readFileSync} from 'node:fs';
// Radix's dialog focus/escape machinery schedules work outside `fireEvent`, so the
// environment must advertise `act` support for those updates to be flushed.
(globalThis as {IS_REACT_ACT_ENVIRONMENT?: boolean}).IS_REACT_ACT_ENVIRONMENT = true;
const mocks=vi.hoisted(()=>({ticket:vi.fn(),decode:vi.fn(),thumbnail:vi.fn(),info:vi.fn()}));
vi.mock('./media',()=>({mediaTicket:mocks.ticket,decodeImage:mocks.decode,loadThumbnail:mocks.thumbnail,invalidateTicket:vi.fn()}));
vi.mock('./AlbumMembershipEditor',()=>({AlbumMembershipEditor:({open}:{open:boolean})=>open?<div>album-editor-open</div>:null}));
vi.mock('./ClassificationAssignmentEditor',()=>({ClassificationAssignmentEditor:({open}:{open:boolean})=>open?<div>classification-editor-open</div>:null}));
vi.mock('./ViewerInfo',()=>({ViewerInfo:(props:{asset:Asset;mediaError:string;onClose():void})=>{mocks.info(props);return <div>viewer-info-open<button aria-label="정보 닫기" onClick={props.onClose}/></div>;}}));
import {Viewer} from './Viewer';
async function showOriginal(id:string) {
  let image!:HTMLImageElement;
  await waitFor(() => { image = document.querySelector<HTMLImageElement>(`.viewer-surface img[src$="original-${id}"]`)!; expect(image).toBeTruthy(); });
  await act(async () => {fireEvent.load(image); await Promise.resolve();});
}
const items:Asset[]=[{id:'a',kind:'image',preview:'https://test.invalid/thumb-a',creator_name:'A'},{id:'b',kind:'image',preview:'https://test.invalid/thumb-b',creator_name:'B'}];
it.each([['분류','classification-editor-open'],['앨범','album-editor-open']])('consumes Android Back in the %s picker before closing the viewer',(label,marker)=>{
  const backRef={current:null as (()=>boolean)|null};
  const onClose=vi.fn();
  render(<Viewer items={items} index={0} onIndex={()=>{}} onClose={onClose} backRef={backRef}/>);
  fireEvent.click(screen.getByRole('button',{name:label}));
  expect(screen.getByText(marker)).toBeTruthy();
  act(()=>{expect(backRef.current?.()).toBe(true);});
  expect(screen.queryByText(marker)).toBeNull();
  expect(onClose).not.toHaveBeenCalled();
  expect(backRef.current?.()).toBe(false);
});
afterEach(()=>{cleanup();delete window.LakomicsNative;vi.restoreAllMocks();});
beforeEach(resetPerfEnabledForTests);
// jsdom has no media playback; the viewer's own calls (resume, release) are observed instead.
beforeEach(()=>{localStorage.clear();Object.defineProperty(window,'innerWidth',{configurable:true,value:800});Object.defineProperty(window,'innerHeight',{configurable:true,value:1280});vi.spyOn(HTMLMediaElement.prototype,'play').mockResolvedValue(undefined);vi.spyOn(HTMLMediaElement.prototype,'load').mockImplementation(()=>{});vi.spyOn(HTMLMediaElement.prototype,'pause').mockImplementation(()=>{});mocks.ticket.mockReset();mocks.decode.mockReset();mocks.thumbnail.mockReset();mocks.info.mockReset();mocks.ticket.mockImplementation((asset:Asset)=>Promise.resolve({url:`https://test.invalid/original-${asset.id}`}));mocks.thumbnail.mockImplementation(async(asset:Asset)=>({...asset,preview:`https://test.invalid/thumb-loaded-${asset.id}`}));});
describe('progressive viewer',()=>{
  it('logs the original commit only after decode and observes prepared neighbour reuse',async()=>{
    const events:Record<string,unknown>[]=[];
    window.LakomicsNative={request:(_id,op,payload)=>{if(op==='perfLog')events.push(JSON.parse(payload));},cancel:vi.fn(),perfEnabled:()=>true};
    let finish!:()=>void;
    mocks.decode.mockImplementation((url:string)=>url.endsWith('a')?new Promise<void>(resolve=>{finish=resolve;}):Promise.resolve());
    const {rerender}=render(<Viewer items={items} index={0} onIndex={()=>{}} onClose={()=>{}}/>);
    await waitFor(()=>expect(events.some(p=>p.event==='native')).toBe(true));
    expect(events.some(p=>p.event==='commit')).toBe(false);
    expect(screen.getByRole('img').getAttribute('src')).toBe(items[0].preview);
    await act(async()=>{finish();});
    await showOriginal('a');
    await waitFor(()=>expect(events.some(p=>p.event==='commit'&&p.prepared===false)).toBe(true));
    expect(screen.getByRole('img').getAttribute('src')).toContain('original-a');
    await waitFor(()=>expect(events.some(p=>p.event==='prefetch_finish'&&p.status==='ok')).toBe(true));
    const requests=mocks.ticket.mock.calls.length;
    rerender(<Viewer items={items} index={1} onIndex={()=>{}} onClose={()=>{}}/>);
    await showOriginal('b');
    await waitFor(()=>expect(events.some(p=>p.event==='commit'&&p.prepared===true&&p.source==='prepared')).toBe(true));
    expect(events.every(p=>!('id' in p))).toBe(true);
    expect(mocks.ticket).toHaveBeenCalledTimes(requests);
  });
  it('does not prefetch a neighbour whose decode would be very large',async()=>{
    const tall:Asset[]=[items[0],{...items[1],width:2000,height:20000},{id:'c',kind:'image',preview:'https://test.invalid/thumb-c',creator_name:'C',width:1600,height:2400}];
    mocks.decode.mockResolvedValue(undefined);
    render(<Viewer items={tall} index={1} onIndex={()=>{}} onClose={()=>{}}/>);
    await waitFor(()=>expect(mocks.ticket.mock.calls.some(([asset])=>(asset as Asset).id==='b')).toBe(true));
    const wide:Asset[]=[items[0],items[1],{id:'c',kind:'image',preview:'https://test.invalid/thumb-c',creator_name:'C',width:2000,height:20000}];
    cleanup();mocks.ticket.mockClear();
    render(<Viewer items={wide} index={1} onIndex={()=>{}} onClose={()=>{}}/>);
    await waitFor(()=>expect(mocks.ticket.mock.calls.some(([asset])=>(asset as Asset).id==='a')).toBe(true));
    expect(mocks.ticket.mock.calls.some(([asset])=>(asset as Asset).id==='c')).toBe(false);
  });
  it('keeps one native media operation across a page append and a swipe onto a prefetch',async()=>{
    const real=await vi.importActual<typeof import('./media')>('./media');real.clearMediaCache();
    mocks.ticket.mockImplementation(real.mediaTicket);mocks.decode.mockResolvedValue(undefined);
    const requests:{id:string;assetId:string}[]=[],cancel=vi.fn();let finish!:()=>void;
    window.LakomicsNative={cancel,request:(id,op,payload)=>{
      if(op!=='media')return;
      const {assetId}=JSON.parse(payload);requests.push({id,assetId});
      const reply=()=>window.dispatchEvent(new CustomEvent('lakomics-native',{detail:{id,ok:true,data:{url:`https://test.invalid/original-${assetId}`,expires_in:240}}}));
      if(assetId==='b')finish=reply;else reply();
    }};
    const props={onIndex:()=>{},onClose:()=>{}};
    const view=render(<Viewer {...props} items={items} index={0}/>);
    try{
      await waitFor(()=>expect(requests.filter(r=>r.assetId==='b')).toHaveLength(1));
      const operation=requests.find(r=>r.assetId==='b')!.id;
      const appended=[...items,{id:'c',kind:'image'},{id:'d',kind:'image'}];
      view.rerender(<Viewer {...props} items={appended} index={0}/>);
      expect(cancel).not.toHaveBeenCalledWith(operation);
      view.rerender(<Viewer {...props} items={appended} index={1}/>);
      expect(cancel).not.toHaveBeenCalledWith(operation);
      expect(requests.filter(r=>r.assetId==='b')).toHaveLength(1);
      await act(async()=>{finish();});
      await showOriginal('b');
      await waitFor(()=>expect(screen.getByRole('img').getAttribute('src')).toContain('original-b'));
      expect(requests.filter(r=>r.assetId==='b')).toHaveLength(1);
      expect(cancel).not.toHaveBeenCalledWith(operation);
    }finally{view.unmount();real.clearMediaCache();}
  });
  it('cancels a pending prefetch only when it leaves the current and neighbour set',async()=>{
    mocks.decode.mockResolvedValue(undefined);
    mocks.ticket.mockImplementation((asset:Asset)=>asset.id==='b'?new Promise(()=>{}):Promise.resolve({url:`https://test.invalid/original-${asset.id}`}));
    const all=[...items,{id:'c',kind:'image'},{id:'d',kind:'image'}],props={onIndex:()=>{},onClose:()=>{}};
    const view=render(<Viewer {...props} items={all} index={0}/>);
    await waitFor(()=>expect(mocks.ticket.mock.calls.some(([a])=>a.id==='b')).toBe(true));
    const signal=mocks.ticket.mock.calls.find(([a])=>a.id==='b')![2] as AbortSignal;
    view.rerender(<Viewer {...props} items={all} index={3}/>);
    expect(signal.aborted).toBe(true);
  });
  it('logs cancellation without claiming a late decode committed',async()=>{
    const events:Record<string,unknown>[]=[];
    window.LakomicsNative={request:(_id,op,payload)=>{if(op==='perfLog')events.push(JSON.parse(payload));},cancel:vi.fn(),perfEnabled:()=>true};
    let finish!:()=>void;mocks.decode.mockImplementation(()=>new Promise<void>(resolve=>{finish=resolve;}));
    const {unmount}=render(<Viewer items={[items[0]]} index={0} onIndex={()=>{}} onClose={()=>{}}/>);
    await waitFor(()=>expect(mocks.decode).toHaveBeenCalledOnce());
    unmount();await act(async()=>{finish();});
    expect(events.filter(p=>p.event==='end')).toMatchObject([{req:expect.any(String),status:'canceled'}]);
    expect(events.some(p=>p.event==='commit')).toBe(false);
  });
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
  it('hides the video controls as soon as the viewer zooms back into its tile',async()=>{
    // The controls sit at the bottom of the full-screen media box, outside the letterboxed picture:
    // left visible they would travel into the tile below it and trail behind the zoom-back.
    const style=document.createElement('style');style.textContent=readFileSync('mobile-client/Viewer.css','utf8');document.head.append(style);
    const animate=vi.fn(()=>({cancel:vi.fn(),finish:vi.fn(),onfinish:null}) as unknown as Animation);
    Object.defineProperty(HTMLElement.prototype,'animate',{configurable:true,value:animate});
    try {
      const onClose=vi.fn();
      render(<Viewer items={[{id:'v',kind:'video'}]} index={0} onIndex={()=>{}} onClose={onClose}/>);
      await waitFor(()=>expect(document.querySelector('video')?.getAttribute('src')??'').toContain('original-v'));
      const controls=document.querySelector<HTMLElement>('.video-player__controls')!;
      expect(getComputedStyle(controls).visibility).not.toBe('hidden');
      fireEvent.click(screen.getByRole('button',{name:'뷰어 닫기'}));
      expect(document.querySelector('[data-viewer-closing]')).not.toBeNull();
      expect(onClose).not.toHaveBeenCalled();
      expect(getComputedStyle(controls).visibility).toBe('hidden');
    } finally {style.remove();delete (HTMLElement.prototype as unknown as {animate?:unknown}).animate;}
  });
  it('renews a failed video and restores its playback position',async()=>{
    render(<Viewer items={[{id:'v',kind:'video'}]} index={0} onIndex={()=>{}} onClose={()=>{}}/>);
    await waitFor(()=>expect(document.querySelector('video')?.getAttribute('src')).toContain('original-v'));
    // The first failure renews the stream once without a message.
    const failed=document.querySelector('video')!;failed.currentTime=25;fireEvent.error(failed);
    await waitFor(()=>expect(mocks.ticket).toHaveBeenCalledTimes(2));
    expect(screen.queryByRole('button',{name:'다시 시도'})).toBeNull();
    const renewed=document.querySelector('video')!;expect(renewed).not.toBe(failed);
    await waitFor(()=>expect(renewed.getAttribute('src')).toContain('original-v'));
    fireEvent.loadedMetadata(renewed);expect(renewed.currentTime).toBe(25);
    // A second failure is shown, and 다시 시도 renews again at the same position.
    renewed.currentTime=30;fireEvent.error(renewed);
    fireEvent.click(await screen.findByRole('button',{name:'다시 시도'}));
    await waitFor(()=>expect(mocks.ticket).toHaveBeenCalledTimes(3));
    const next=document.querySelector('video')!;expect(next).not.toBe(renewed);fireEvent.loadedMetadata(next);expect(next.currentTime).toBe(30);
  });
  describe('library video without progress',()=>{
    beforeEach(()=>{vi.useFakeTimers({shouldAdvanceTime:true});});
    afterEach(()=>{vi.useRealTimers();});
    const source=async()=>{await waitFor(()=>expect(document.querySelector('video')?.getAttribute('src')??'').toContain('original-v'));return document.querySelector('video')!;};
    it('renews once with a fresh ticket when metadata does not arrive, then shows the delay message',async()=>{
      const events:Record<string,unknown>[]=[];
      window.LakomicsNative={request:(_id,op,payload)=>{if(op==='perfLog')events.push(JSON.parse(payload));},cancel:vi.fn(),perfEnabled:()=>true};
      const media=await import('./media');
      render(<Viewer items={[{id:'v',kind:'video'}]} index={0} onIndex={()=>{}} onClose={()=>{}}/>);
      const first=await source();fireEvent.loadStart(first);
      await act(async()=>{vi.advanceTimersByTime(7900);});
      expect(mocks.ticket).toHaveBeenCalledTimes(1);
      await act(async()=>{vi.advanceTimersByTime(200);});
      await waitFor(()=>expect(mocks.ticket).toHaveBeenCalledTimes(2));
      expect(media.invalidateTicket).toHaveBeenCalledWith(expect.objectContaining({id:'v'}),'original');
      await waitFor(()=>expect(events.some(p=>p.event==='video'&&p.media==='retry')).toBe(true));
      expect(screen.queryByText(/영상 연결이 지연되고/)).toBeNull();
      // The stalled element is released: no src, network stopped.
      expect(first.hasAttribute('src')).toBe(false);expect(HTMLMediaElement.prototype.load).toHaveBeenCalled();
      const second=await source();expect(second).not.toBe(first);expect(second.autoplay).toBe(true);
      fireEvent.loadStart(second);
      await act(async()=>{vi.advanceTimersByTime(8100);});
      expect(await screen.findByText(/영상 연결이 지연되고/)).toBeTruthy();
      expect(mocks.ticket).toHaveBeenCalledTimes(2);
    });
    it('leaves a video alone once its metadata arrived',async()=>{
      render(<Viewer items={[{id:'v',kind:'video'}]} index={0} onIndex={()=>{}} onClose={()=>{}}/>);
      const player=await source();fireEvent.loadStart(player);fireEvent.loadedMetadata(player);
      await act(async()=>{vi.advanceTimersByTime(20000);});
      expect(mocks.ticket).toHaveBeenCalledTimes(1);expect(document.querySelector('video')).toBe(player);
      expect(screen.queryByText(/영상 연결이 지연되고/)).toBeNull();
    });
    it('cancels the pending check and releases the element when the asset changes or the viewer closes',async()=>{
      mocks.decode.mockResolvedValue(undefined);
      const all:Asset[]=[{id:'v',kind:'video'},items[1]];
      const view=render(<Viewer items={all} index={0} onIndex={()=>{}} onClose={()=>{}}/>);
      const player=await source();fireEvent.loadStart(player);
      view.rerender(<Viewer items={all} index={1} onIndex={()=>{}} onClose={()=>{}}/>);
      expect(player.hasAttribute('src')).toBe(false);
      expect(HTMLMediaElement.prototype.pause).toHaveBeenCalled();expect(HTMLMediaElement.prototype.load).toHaveBeenCalled();
      await act(async()=>{vi.advanceTimersByTime(9000);});
      expect(mocks.ticket.mock.calls.filter(([a])=>a.id==='v')).toHaveLength(1);
      view.rerender(<Viewer items={all} index={0} onIndex={()=>{}} onClose={()=>{}}/>);
      const again=await source();view.unmount();
      expect(again.hasAttribute('src')).toBe(false);
    });
    it('never renews vault videos',async()=>{
      const vault={original:(asset:Asset)=>`https://app.lakomics.local/vault/${'a'.repeat(32)}/${asset.id}`,label:(asset:Asset)=>asset.id};
      render(<Viewer items={[{id:'v',kind:'video'}]} index={0} onIndex={()=>{}} onClose={()=>{}} vault={vault}/>);
      const player=document.querySelector('video')!;fireEvent.loadStart(player);
      await act(async()=>{vi.advanceTimersByTime(20000);});
      expect(document.querySelector('video')).toBe(player);expect(player.getAttribute('src')).toContain('/vault/');expect(mocks.ticket).not.toHaveBeenCalled();
    });
  });
  it('retains the thumbnail until original decoding completes',async()=>{
    let finish!:()=>void; mocks.decode.mockImplementation(()=>new Promise<void>(resolve=>{finish=resolve;}));
    render(<Viewer items={[items[0]]} index={0} onIndex={()=>{}} onClose={()=>{}}/>);
    expect(screen.getByRole('img').getAttribute('src')).toBe(items[0].preview);
    await waitFor(()=>expect(mocks.decode).toHaveBeenCalledOnce());
    expect(screen.getByRole('img').getAttribute('src')).toBe(items[0].preview);
    await act(async () => finish()); await showOriginal('a'); await waitFor(()=>expect(screen.getByRole('img').getAttribute('src')).toContain('original-a'));
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
    await showOriginal('b');
    await waitFor(()=>expect(screen.getByRole('img').getAttribute('src')).toContain('original-b'));
    finishA(); expect(screen.getByRole('img').getAttribute('src')).toContain('original-b');
  });
  it('swipes across shared video content while keeping timeline gestures inside the player',async()=>{
    const change=vi.fn();render(<Viewer items={[{id:'v',kind:'video'},items[1]]} index={0} onIndex={change} onClose={()=>{}}/>);
    await waitFor(()=>expect(document.querySelector('video')?.getAttribute('src')).toContain('original-v'));
    const surface=document.querySelector('.viewer-surface')!;
    fireEvent.pointerDown(surface,{pointerId:1,button:0,clientX:600,clientY:300});fireEvent.pointerUp(surface,{pointerId:1,clientX:200,clientY:300});expect(change).toHaveBeenCalledWith(1);
    change.mockClear();
    const timeline=screen.getByRole('slider',{name:'재생 위치'});
    fireEvent.pointerDown(timeline,{pointerId:2,button:0,clientX:600,clientY:570});
    fireEvent.pointerMove(timeline,{pointerId:2,clientX:200,clientY:570});
    fireEvent.pointerUp(timeline,{pointerId:2,clientX:200,clientY:570});
    expect(change).not.toHaveBeenCalled();
  });
  it('keeps the shared video element mounted while switching between videos',async()=>{
    const videos:Asset[]=[{id:'v1',kind:'video',preview:'poster:1'},{id:'v2',kind:'video',preview:'poster:2'}];
    const view=render(<Viewer items={videos} index={0} onIndex={()=>{}} onClose={()=>{}}/>);
    await waitFor(()=>expect(document.querySelector('video')?.getAttribute('src')).toContain('original-v1'));
    const first=document.querySelector('video');
    view.rerender(<Viewer items={videos} index={1} onIndex={()=>{}} onClose={()=>{}}/>);
    expect(document.querySelector('video')).toBe(first);
    await waitFor(()=>expect(document.querySelector('video')?.getAttribute('src')).toContain('original-v2'));
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
  describe('video taps',()=>{
    const videoItems:Asset[]=[items[0],{id:'v',kind:'video'}];
    const viewer=()=>document.querySelector<HTMLElement>('.viewer')!;
    const tap=(x=300)=>{const v=document.querySelector('video')!;fireEvent.pointerDown(v,{pointerId:1,button:0,clientX:x,clientY:300});fireEvent.pointerUp(v,{pointerId:1,clientX:x,clientY:300});};
    beforeEach(()=>{vi.useFakeTimers();});
    afterEach(()=>{vi.useRealTimers();});
    it('does not autoplay a video reached inside the viewer and keeps the strip up',()=>{
      const view=render(<Viewer items={videoItems} index={0} onIndex={()=>{}} onClose={()=>{}}/>);
      view.rerender(<Viewer items={videoItems} index={1} onIndex={()=>{}} onClose={()=>{}}/>);
      expect(document.querySelector('video')!.autoplay).toBe(false);
      expect(viewer().dataset.filmstripVisible).toBe('true');
      expect(screen.getByRole('navigation',{name:'주변 자산'})).toBeTruthy();
      // Returning to a video the viewer was opened on no longer autoplays it either.
      cleanup();
      const back=render(<Viewer items={videoItems} index={1} onIndex={()=>{}} onClose={()=>{}}/>);
      expect(document.querySelector('video')!.autoplay).toBe(true);
      back.rerender(<Viewer items={videoItems} index={0} onIndex={()=>{}} onClose={()=>{}}/>);
      back.rerender(<Viewer items={videoItems} index={1} onIndex={()=>{}} onClose={()=>{}}/>);
      expect(document.querySelector('video')!.autoplay).toBe(false);
    });
    it('follows the same autoplay rule for vault videos',()=>{
      const vault={original:(asset:Asset)=>`https://app.lakomics.local/vault/s/${asset.id}`,label:(asset:Asset)=>asset.id};
      const view=render(<Viewer items={videoItems} index={0} onIndex={()=>{}} onClose={()=>{}} vault={vault}/>);
      view.rerender(<Viewer items={videoItems} index={1} onIndex={()=>{}} onClose={()=>{}} vault={vault}/>);
      expect(document.querySelector('video')!.autoplay).toBe(false);
      cleanup();
      render(<Viewer items={videoItems} index={1} onIndex={()=>{}} onClose={()=>{}} vault={vault}/>);
      expect(document.querySelector('video')!.autoplay).toBe(true);
    });
    it('plays a paused video on one tap and hides the strip',()=>{
      const view=render(<Viewer items={videoItems} index={0} onIndex={()=>{}} onClose={()=>{}}/>);
      view.rerender(<Viewer items={videoItems} index={1} onIndex={()=>{}} onClose={()=>{}}/>);
      tap();
      expect(HTMLMediaElement.prototype.play).toHaveBeenCalledOnce();
      fireEvent.play(document.querySelector('video')!);
      expect(viewer().dataset.filmstripVisible).toBe('false');
    });
    it('pauses a playing video on a double tap and brings the strip and chrome back without toggling them',()=>{
      render(<Viewer items={videoItems} index={1} onIndex={()=>{}} onClose={()=>{}}/>);
      const video=document.querySelector('video')!;
      fireEvent.play(video);
      act(()=>{vi.advanceTimersByTime(2000);});
      expect(viewer().classList.contains('chrome-visible')).toBe(false);
      tap();act(()=>{vi.advanceTimersByTime(150);});tap(310);
      expect(HTMLMediaElement.prototype.pause).toHaveBeenCalledOnce();
      expect(HTMLMediaElement.prototype.play).not.toHaveBeenCalled();
      expect(viewer().classList.contains('chrome-visible')).toBe(true);
      act(()=>{vi.advanceTimersByTime(400);});
      expect(viewer().classList.contains('chrome-visible')).toBe(true);
      fireEvent.pause(video);
      expect(viewer().dataset.filmstripVisible).toBe('true');
      expect(viewer().classList.contains('chrome-visible')).toBe(true);
    });
    it('toggles the chrome on a single tap while playing only after the double-tap window',()=>{
      const change=vi.fn();
      render(<Viewer items={videoItems} index={1} onIndex={change} onClose={()=>{}}/>);
      fireEvent.play(document.querySelector('video')!);
      expect(viewer().classList.contains('chrome-visible')).toBe(true);
      tap();
      expect(viewer().classList.contains('chrome-visible')).toBe(true);
      act(()=>{vi.advanceTimersByTime(300);});
      expect(viewer().classList.contains('chrome-visible')).toBe(false);
      tap();act(()=>{vi.advanceTimersByTime(300);});
      expect(viewer().classList.contains('chrome-visible')).toBe(true);
      expect(HTMLMediaElement.prototype.play).not.toHaveBeenCalled();
      expect(HTMLMediaElement.prototype.pause).not.toHaveBeenCalled();
      expect(change).not.toHaveBeenCalled();
    });
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
  it('keeps the information open when moving to another asset',()=>{
    const {rerender}=render(<Viewer items={items} index={0} onIndex={()=>{}} onClose={()=>{}}/>);
    fireEvent.click(screen.getByRole('button',{name:'미디어 정보'}));
    expect(screen.getByText('viewer-info-open')).toBeTruthy();
    rerender(<Viewer items={items} index={1} onIndex={()=>{}} onClose={()=>{}}/>);
    expect(screen.getByText('viewer-info-open')).toBeTruthy();
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

describe('tablet immersive viewer chrome',()=>{
  it('shows the position, handle-first title, date and optional folder path',()=>{
    const current:Asset={...items[0],creator_name:'Display Name',creator_handle:'maker',collected_at:'2026-09-29T07:20:00'};
    render(<Viewer items={[current,items[1]]} index={0} totalCount={9453} folderLabel={()=>'작가 / 스케치'} onIndex={()=>{}} onClose={()=>{}}/>);
    expect(screen.getByText('1 / 9,453')).toBeTruthy();
    expect(screen.getByText('@maker')).toBeTruthy();
    expect(screen.getByText('9.29 07:20 · 작가 / 스케치')).toBeTruthy();
    expect(screen.getByRole('button',{name:'분류'}).className).toContain('viewer-action');
    expect(screen.getByRole('button',{name:'앨범'}).className).toContain('viewer-action');
  });

  it('renders the available filmstrip window and jumps through a thumbnail',()=>{
    const change=vi.fn();
    const many=Array.from({length:15},(_,index)=>({id:`asset-${index}`,kind:'image',preview:`thumb:${index}`} as Asset));
    render(<Viewer items={many} index={7} onIndex={change} onClose={()=>{}}/>);
    const strip=screen.getByRole('navigation',{name:'주변 자산'});
    expect(strip.querySelectorAll('button')).toHaveLength(15);
    expect(strip.querySelector('[aria-current="true"]')?.getAttribute('aria-label')).toBe('8번째 자산 보기');
    fireEvent.click(screen.getByRole('button',{name:'3번째 자산 보기'}));
    expect(change).toHaveBeenCalledWith(2);
  });

  it('omits the strip for a single item and overlays it for paused video',()=>{
    const {rerender}=render(<Viewer items={[items[0]]} index={0} onIndex={()=>{}} onClose={()=>{}}/>);
    expect(screen.queryByRole('navigation',{name:'주변 자산'})).toBeNull();
    rerender(<Viewer items={[{...items[0],kind:'video'},items[1]]} index={0} onIndex={()=>{}} onClose={()=>{}}/>);
    expect(screen.queryByRole('navigation',{name:'주변 자산'})).toBeTruthy();
    fireEvent.play(document.querySelector('video')!);
    expect(document.querySelector('.viewer')?.classList.contains('is-playing')).toBe(true);
    fireEvent.pause(document.querySelector('video')!);
    expect(document.querySelector('.viewer')?.classList.contains('is-playing')).toBe(false);
  });

  it('uses the portrait sheet and the landscape dock for information',()=>{
    const portrait=render(<Viewer items={items} index={0} onIndex={()=>{}} onClose={()=>{}}/>);
    fireEvent.click(screen.getByRole('button',{name:'미디어 정보'}));
    expect(screen.getByRole('dialog',{name:'미디어 정보'}).querySelector('.library-sheet')).toBeTruthy();
    portrait.unmount();

    Object.defineProperty(window,'innerWidth',{configurable:true,value:1280});
    Object.defineProperty(window,'innerHeight',{configurable:true,value:800});
    render(<Viewer items={items} index={0} onIndex={()=>{}} onClose={()=>{}}/>);
    fireEvent.click(screen.getByRole('button',{name:'미디어 정보'}));
    expect(screen.queryByRole('dialog',{name:'미디어 정보'})).toBeNull();
    expect(screen.getByRole('complementary',{name:'미디어 정보'})).toBeTruthy();
  });

  it('closes the landscape information dock with Android Back before the viewer',()=>{
    Object.defineProperty(window,'innerWidth',{configurable:true,value:1280});
    Object.defineProperty(window,'innerHeight',{configurable:true,value:800});
    const backRef:{current:(()=>boolean)|null}={current:null};
    render(<Viewer items={items} index={0} onIndex={()=>{}} onClose={()=>{}} backRef={backRef}/>);
    fireEvent.click(screen.getByRole('button',{name:'미디어 정보'}));
    let consumed=false;
    act(()=>{consumed=backRef.current!();});
    expect(consumed).toBe(true);
    expect(screen.queryByRole('complementary',{name:'미디어 정보'})).toBeNull();
  });

  it('auto-hides image and shared video controls through the same chrome state',()=>{
    vi.useFakeTimers();
    try {
      const {rerender}=render(<Viewer items={items} index={0} onIndex={()=>{}} onClose={()=>{}}/>);
      act(()=>{vi.advanceTimersByTime(2500);});
      expect(document.querySelector('.viewer')?.classList.contains('chrome-visible')).toBe(false);
      rerender(<Viewer items={[{id:'v',kind:'video'},items[1]]} index={0} onIndex={()=>{}} onClose={()=>{}}/>);
      fireEvent.play(document.querySelector('video')!);
      act(()=>{vi.advanceTimersByTime(2000);});
      expect(document.querySelector('.viewer')?.classList.contains('chrome-visible')).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps chrome visible while a finger owns the filmstrip',()=>{
    vi.useFakeTimers();
    try {
      render(<Viewer items={items} index={0} onIndex={()=>{}} onClose={()=>{}}/>);
      const thumb=screen.getByRole('button',{name:'1번째 자산 보기'});
      fireEvent.pointerDown(thumb,{pointerId:9,clientX:20,clientY:20});
      act(()=>{vi.advanceTimersByTime(3000);});
      expect(document.querySelector('.viewer')?.classList.contains('chrome-visible')).toBe(true);
      fireEvent.pointerUp(thumb,{pointerId:9,clientX:20,clientY:20});
      act(()=>{vi.advanceTimersByTime(2500);});
      expect(document.querySelector('.viewer')?.classList.contains('chrome-visible')).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});
describe('viewer Library Trash action',()=>{
  it('offers 휴지통으로 without confirmation and renders the host snackbar inside the viewer',async()=>{
    const trash=vi.fn();
    render(<Viewer items={items} index={1} onIndex={()=>{}} onClose={()=>{}} onTrash={trash} trashNotice={<div role="status">휴지통으로 이동함</div>}/>);
    fireEvent.click(screen.getByRole('button',{name:'휴지통으로'}));
    expect(trash).toHaveBeenCalledWith(items[1]);
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(screen.getByText('휴지통으로 이동함')).toBeTruthy();
  });
  it('has no trash action without the capability or for a pending capture',()=>{
    const {rerender}=render(<Viewer items={items} index={0} onIndex={()=>{}} onClose={()=>{}}/>);
    expect(screen.queryByRole('button',{name:'휴지통으로'})).toBeNull();
    rerender(<Viewer items={[{id:'p',kind:'image',pending:true}]} index={0} onIndex={()=>{}} onClose={()=>{}} onTrash={()=>{}}/>);
    expect(screen.queryByRole('button',{name:'휴지통으로'})).toBeNull();
  });
});

describe('vault source',()=>{
  const vaultItems:Asset[]=[{id:'v1',kind:'image',preview:'https://app.lakomics.local/vault/s/t1'},{id:'v2',kind:'video'}];
  const vault={original:(asset:Asset)=>`https://app.lakomics.local/vault/s/${asset.id}`,label:(asset:Asset)=>`제목 ${asset.id}`};
  it('uses the vault route directly with the same chrome and no library media, timing or actions',async()=>{
    const media=await import('./media');vi.mocked(media.invalidateTicket).mockClear();
    const native=vi.fn();window.LakomicsNative={request:native,cancel:vi.fn()};
    const onIndex=vi.fn();
    const view=render(<Viewer items={vaultItems} index={0} onIndex={onIndex} onClose={()=>{}} vault={vault}/>);
    const original=screen.getByAltText('제목 v1');
    expect(original.getAttribute('src')).toBe('https://app.lakomics.local/vault/s/v1');
    expect(document.querySelector('.viewer-placeholder')?.getAttribute('src')).toBe(vaultItems[0].preview);
    fireEvent.load(original);
    expect(document.querySelector('.viewer-placeholder')).toBeNull();
    expect(screen.getByText('1 / 2')).toBeTruthy();expect(screen.getByText('제목 v1')).toBeTruthy();
    for(const action of ['분류','앨범','미디어 정보','휴지통으로'])expect(screen.queryByRole('button',{name:action})).toBeNull();
    fireEvent.click(screen.getByRole('button',{name:'다음 자산'}));
    expect(onIndex).toHaveBeenCalledWith(1);
    view.rerender(<Viewer items={vaultItems} index={1} onIndex={onIndex} onClose={()=>{}} vault={vault}/>);
    const video=document.querySelector('video')!;
    expect(video.getAttribute('src')).toBe('https://app.lakomics.local/vault/s/v2');
    expect(video.getAttribute('controlsList')).toBe('nodownload noremoteplayback');
    expect(video.hasAttribute('disablePictureInPicture')).toBe(true);
    fireEvent.error(video);
    fireEvent.click(await screen.findByRole('button',{name:'다시 시도'}));
    expect(document.querySelector('video')?.getAttribute('src')).toBe('https://app.lakomics.local/vault/s/v2');
    await act(async()=>{await Promise.resolve();});
    expect(mocks.ticket).not.toHaveBeenCalled();expect(mocks.decode).not.toHaveBeenCalled();
    expect(media.invalidateTicket).not.toHaveBeenCalled();
    expect(native).not.toHaveBeenCalled();
  });
});

describe('vault image arrival',()=>{
  const vaultItems:Asset[]=[{id:'v1',kind:'image',preview:'https://app.lakomics.local/vault/s/t1'}];
  const vault={original:(asset:Asset)=>`https://app.lakomics.local/vault/s/${asset.id}`,label:(asset:Asset)=>`제목 ${asset.id}`};
  it.each([false,true])('crossfades the full image over the low-resolution placeholder before removing it (reduced=%s)',reduced=>{
    vi.stubGlobal('matchMedia',vi.fn(()=>({matches:reduced,addEventListener:vi.fn(),removeEventListener:vi.fn()})));
    try{
      render(<Viewer items={vaultItems} index={0} onIndex={()=>{}} onClose={()=>{}} vault={vault}/>);
      const original=screen.getByAltText('제목 v1');
      let finish:(()=>void)|undefined;
      const animate=vi.fn(()=>({addEventListener:(type:string,listener:()=>void)=>{if(type==='finish')finish=listener;},cancel:vi.fn()}));
      Object.assign(original,{animate});
      fireEvent.load(original);
      expect(animate).toHaveBeenCalledWith([{opacity:0},{opacity:1}],expect.objectContaining({duration:reduced?120:150}));
      expect(original.style.opacity).toBe('1');
      // The placeholder stays under the fading image until the fade has finished.
      expect(document.querySelector('.viewer-placeholder')).not.toBeNull();
      act(()=>finish!());
      expect(document.querySelector('.viewer-placeholder')).toBeNull();
    }finally{vi.unstubAllGlobals();}
  });
});

describe('video controls',()=>{
  // jsdom has no layout, so the guarantee is checked on the classes and on the overlay layout rules.
  const css=readFileSync('mobile-client/mobile.css','utf8');
  const overlay=css.slice(css.indexOf('@media (orientation:portrait), (max-width:999px)'));
  it('keeps the footer out of the video controls in vault and library mode',()=>{
    const vault={original:(asset:Asset)=>`https://app.lakomics.local/vault/s/${asset.id}`,label:(asset:Asset)=>asset.id};
    for(const props of [{vault},{}]){
      mocks.ticket.mockResolvedValue({url:'https://test.invalid/original-v'});
      const view=render(<Viewer items={[{id:'v',kind:'video'}]} index={0} onIndex={()=>{}} onClose={()=>{}} {...props}/>);
      const viewer=document.querySelector('.viewer')!,surface=viewer.querySelector('.viewer-surface')!,footer=viewer.querySelector('footer.viewer-bar');
      expect(viewer.classList.contains('is-video')).toBe(true);
      if (props.vault) {
        expect(footer).toBeTruthy();
        expect(footer!.contains(surface)).toBe(false);
      } else {
        expect(footer).toBeNull();
      }
      view.unmount();
    }
    // Where bars otherwise overlay the media, a video viewer returns to row layout and static bars.
    expect(overlay).toMatch(/\.viewer\.is-video \{ display:grid; \}/);
    expect(overlay).toMatch(/\.viewer\.is-video \.viewer-bar \{ position:static;/);
    expect(overlay.indexOf('.viewer.is-video .viewer-bar')).toBeGreaterThan(overlay.indexOf('.viewer-bar { position:absolute'));
    // Status messages sit at the top for video, never over the seek bar.
    expect(css).toMatch(/\.viewer\.is-video \.viewer-error \{ bottom:auto; top:64px; \}/);
  });
  it('does not mark image viewers as video',()=>{
    render(<Viewer items={items} index={0} onIndex={()=>{}} onClose={()=>{}}/>);
    expect(document.querySelector('.viewer')!.classList.contains('is-video')).toBe(false);
  });
});
describe('viewer bars',()=>{
  it('toggles the bars only by tapping the image and keeps them hidden while swiping to other items',async()=>{
    mocks.decode.mockResolvedValue(undefined);
    const onIndex=vi.fn();
    const view=render(<Viewer items={items} index={0} onIndex={onIndex} onClose={()=>{}}/>);
    const viewer=()=>document.querySelector('.viewer')!;
    const surface=()=>document.querySelector('.viewer-surface')!;
    const tap=()=>{fireEvent.pointerDown(surface(),{pointerId:1,button:0,clientX:300,clientY:300});fireEvent.pointerUp(surface(),{pointerId:1,clientX:300,clientY:300});};
    expect(viewer().classList.contains('chrome-visible')).toBe(true);
    tap();expect(viewer().classList.contains('chrome-visible')).toBe(false);
    // A swipe changes the item without bringing the bars back.
    fireEvent.pointerDown(surface(),{pointerId:2,button:0,clientX:600,clientY:300});fireEvent.pointerUp(surface(),{pointerId:2,clientX:200,clientY:300});
    expect(onIndex).toHaveBeenCalledWith(1);
    view.rerender(<Viewer items={items} index={1} onIndex={onIndex} onClose={()=>{}}/>);
    await waitFor(()=>expect(screen.getByRole('img').getAttribute('src')).toContain('b'));
    expect(viewer().classList.contains('chrome-visible')).toBe(false);
    tap();expect(viewer().classList.contains('chrome-visible')).toBe(true);
  });
});


it('closes the open asset viewer without keeping any image source in privacy mode',async()=>{
 mocks.ticket.mockImplementation(()=>new Promise(()=>{}));
 const close=vi.fn();render(<Viewer items={items} index={0} onIndex={()=>{}} onClose={close}/>);
 await waitFor(()=>expect(mocks.ticket).toHaveBeenCalled());
 const signals=mocks.ticket.mock.calls.map(call=>call[2]).filter(Boolean) as AbortSignal[];
 act(()=>{localStorage.setItem('lakomics.mobile.privacyMode','1');window.dispatchEvent(new Event('lakomics-privacy-mode'));});
 expect(document.querySelector('img[src]')).toBeNull();expect(screen.queryByRole('dialog')).toBeNull();expect(close).toHaveBeenCalledOnce();
 expect(signals.every(signal=>signal.aborted)).toBe(true);
});
it('does not request media when opened while privacy is enabled',()=>{
 localStorage.setItem('lakomics.mobile.privacyMode','1');const close=vi.fn();
 render(<Viewer items={items} index={0} onIndex={()=>{}} onClose={close}/>);
 expect(mocks.ticket).not.toHaveBeenCalled();expect(document.querySelector('img[src]')).toBeNull();expect(close).toHaveBeenCalledOnce();
});

it.each(['image', 'video'])('grows after a strip swipe and shrinks on a %s surface tap',(kind)=>{
  render(<Viewer items={[{...items[0],kind},items[1]]} index={0} onIndex={()=>{}} onClose={()=>{}}/>);
  const viewer=document.querySelector<HTMLElement>('.viewer')!;
  const strip=screen.getByRole('navigation',{name:'주변 자산'});
  expect(strip.classList.contains('is-grown')).toBe(false);
  expect(viewer.style.getPropertyValue('--viewer-controls-offset')).toBe('70px');
  fireEvent.pointerDown(strip,{pointerId:91,clientX:100,clientY:150});
  fireEvent.pointerMove(strip,{pointerId:91,clientX:100,clientY:70});
  fireEvent.pointerUp(strip,{pointerId:91,clientX:100,clientY:70});
  expect(strip.classList.contains('is-grown')).toBe(true);
  expect(viewer.style.getPropertyValue('--viewer-controls-offset')).toBe('144px');
  const surface=document.querySelector('.viewer-surface')!;
  fireEvent.pointerDown(surface,{pointerId:92,clientX:100,clientY:100});
  fireEvent.pointerUp(surface,{pointerId:92,clientX:100,clientY:100});
  expect(strip.classList.contains('is-grown')).toBe(false);
  expect(viewer.style.getPropertyValue('--viewer-controls-offset')).toBe('70px');
});

it('drops playback controls when the strip hides and restores their grown offset on pause',()=>{
  vi.useFakeTimers();
  try {
    const props={items:[{...items[0],kind:'video'},items[1]],index:0,onIndex:()=>{},onClose:()=>{}};
    const view=render(<Viewer {...props}/>);
    const viewer=document.querySelector<HTMLElement>('.viewer')!;
    const strip=screen.getByRole('navigation',{name:'주변 자산'});
    const surface=document.querySelector('.viewer-surface');
    const video=document.querySelector('video')!;
    const player=document.querySelector('.video-player')!;
    expect(viewer.dataset.filmstripVisible).toBe('true');
    expect(viewer.style.getPropertyValue('--viewer-controls-offset')).toBe('70px');
    fireEvent.pointerDown(strip,{pointerId:91,clientX:100,clientY:150});
    fireEvent.pointerMove(strip,{pointerId:91,clientX:100,clientY:70});
    fireEvent.pointerUp(strip,{pointerId:91,clientX:100,clientY:70});
    expect(viewer.style.getPropertyValue('--viewer-controls-offset')).toBe('144px');
    fireEvent.play(video);
    expect(viewer.dataset.filmstripVisible).toBe('false');
    expect(viewer.style.getPropertyValue('--viewer-controls-offset')).toBe('0px');
    expect(player.getAttribute('data-controls-visible')).toBe('true');
    act(()=>vi.advanceTimersByTime(2000));
    expect(player.getAttribute('data-controls-visible')).toBe('false');
    fireEvent.pause(video);
    expect(viewer.dataset.filmstripVisible).toBe('true');
    expect(viewer.style.getPropertyValue('--viewer-controls-offset')).toBe('144px');
    expect(player.getAttribute('data-controls-visible')).toBe('true');
    expect(document.querySelector('.viewer-surface')).toBe(surface);
    expect(document.querySelector('video')).toBe(video);
    view.rerender(<Viewer {...props} items={[props.items[0]]}/>);
    expect(viewer.style.getPropertyValue('--viewer-controls-offset')).toBe('0px');
    view.rerender(<Viewer {...props} vault={{original:()=>'',label:()=>''}}/>);
    expect(viewer.style.getPropertyValue('--viewer-controls-offset')).toBe('0px');
  } finally {vi.useRealTimers();}
});

it('keeps the actual painted slot until the next original loads and decodes',async()=>{
  const props={items,onIndex:()=>{},onClose:()=>{}};
  const view=render(<Viewer {...props} index={0}/>);
  await showOriginal('a');
  const old=screen.getByRole('img');
  view.rerender(<Viewer {...props} index={1}/>);
  await waitFor(()=>expect(document.querySelector('.viewer-surface img[src$="original-b"]')).toBeTruthy());
  expect(screen.getByRole('img')).toBe(old);
  const next=document.querySelector<HTMLImageElement>('.viewer-surface img[src$="original-b"]')!;
  let finish!:()=>void;
  Object.defineProperty(next,'decode',{value:()=>new Promise<void>(resolve=>{finish=resolve;})});
  fireEvent.load(next);
  expect(screen.getByRole('img')).toBe(old);
  await act(async()=>finish());
  expect(screen.getByRole('img')).toBe(next);
});

it('NSFW opens a masked viewer, requests no original and keeps unsafe filmstrip cells masked',()=>{
 localStorage.setItem('lakomics.mobile.nsfwFilter','1');
 const close=vi.fn(),onIndex=vi.fn();
 const {container}=render(<Viewer items={[{id:'e',kind:'image',contentRating:'e',preview:'blob:unsafe'},{id:'u',kind:'image',preview:'blob:unknown'}]} index={0} onIndex={onIndex} onClose={close}/>);
 expect(screen.getByRole('dialog')).toBeTruthy();expect(container.querySelector('img[src]')).toBeNull();
 expect(mocks.ticket).not.toHaveBeenCalled();expect(mocks.decode).not.toHaveBeenCalled();expect(mocks.thumbnail).not.toHaveBeenCalled();
 expect(close).not.toHaveBeenCalled();fireEvent.click(screen.getByRole('button',{name:'다음 자산'}));expect(onIndex).toHaveBeenCalledWith(1);
});
it('NSFW does not preload the unsafe neighbour from a safe viewer',async()=>{
 localStorage.setItem('lakomics.mobile.nsfwFilter','1');
 const items:Asset[]=[{id:'g',kind:'image',contentRating:'g',preview:'blob:safe'},{id:'e',kind:'image',contentRating:'e',preview:'blob:unsafe'}];
 render(<Viewer items={items} index={0} onIndex={vi.fn()} onClose={vi.fn()}/>);
 await waitFor(()=>expect(mocks.ticket).toHaveBeenCalled());
 expect(mocks.ticket.mock.calls.every(call=>call[0].id==='g')).toBe(true);
 expect(document.querySelector('img[src="blob:unsafe"]')).toBeNull();
});
