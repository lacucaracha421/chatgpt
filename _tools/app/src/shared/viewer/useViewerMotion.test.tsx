import {act, cleanup, fireEvent, render, screen} from '@testing-library/react';
import {afterEach, beforeEach, expect, it, vi} from 'vitest';
import {StableImage} from '../ui/StableImage';
import {useViewerMotion} from './useViewerMotion';
const rect = (left:number, top:number, width:number, height:number) => ({left,top,width,height,right:left+width,bottom:top+height,x:left,y:top,toJSON:()=>({})});
let calls: {element:HTMLElement; frames:Keyframe[]; options:KeyframeAnimationOptions; animation:Animation}[];
function Fixture({id='a',onClose=vi.fn()}:{id?:string;onClose?:()=>void}) {
  const motion=useViewerMotion(id,onClose,undefined,2,`original:${id}`);
  return <div ref={motion.bind} className="asset-viewer"><div data-viewer-backdrop/><div data-viewer-media><StableImage src={`original:${id}`} alt={id}/></div><button onClick={motion.close}>close</button></div>;
}
beforeEach(() => {
  calls=[];
  vi.stubGlobal('matchMedia',()=>({matches:false}));
  vi.spyOn(HTMLElement.prototype,'getBoundingClientRect').mockImplementation(function(this: HTMLElement) {
    return this.hasAttribute('data-asset-id') ? rect(this.dataset.assetId==='a'?20:220,30,100,50) : rect(0,0,800,600);
  });
  Object.defineProperty(HTMLElement.prototype, 'animate', {configurable:true, value: vi.fn(function(this:HTMLElement, frames:Keyframe[], options:KeyframeAnimationOptions) {
    const animation={cancel:vi.fn(),onfinish:null} as unknown as Animation;
    calls.push({element:this,frames:frames as Keyframe[],options:options as KeyframeAnimationOptions,animation});return animation;
  })});
  const gallery=document.createElement('div');gallery.id='test-gallery';
  gallery.innerHTML='<div data-asset-id="a"><img src="thumb:a"></div><div data-asset-id="b"><img src="thumb:b"></div>';
  document.body.append(gallery);
});
afterEach(()=>{cleanup();document.querySelector('#test-gallery')?.remove();vi.restoreAllMocks();vi.unstubAllGlobals();delete (HTMLElement.prototype as unknown as {animate?:unknown}).animate;});
it('grows the tapped tile in 380 ms and keeps its preview until media is ready', async () => {
  render(<Fixture/>);
  const zoom=calls.find(call=>call.options.duration===380)!;
  expect(zoom.frames[0].transform).toContain('scale(0.125)');
  expect(zoom.options.easing).toBe('cubic-bezier(.32,.72,0,1)');
  expect(calls.some(call=>call.options.duration===228)).toBe(true);
  act(()=>zoom.animation.onfinish?.(new Event('finish') as AnimationPlaybackEvent));
  expect(zoom.element.isConnected).toBe(true);
  await act(async()=>fireEvent.load(screen.getByRole('img',{name:'a'})));
  expect(zoom.element.isConnected).toBe(false);
});
it('closes into the last painted tile while a replacement is still loading', () => {
  const onClose=vi.fn();
  const view=render(<Fixture onClose={onClose}/>);
  view.rerender(<Fixture id="b" onClose={onClose}/>);
  fireEvent.click(screen.getByText('close'));
  const closing=calls.find(call=>call.options.duration===320)!;
  expect(closing.frames[1].transform).toBe('translate(-330px,-245px) scale(0.125)');
  expect(onClose).not.toHaveBeenCalled();
  act(()=>closing.animation.onfinish?.(new Event('finish') as AnimationPlaybackEvent));
  expect(onClose).toHaveBeenCalledOnce();
});
it('closes into the newly ready asset tile after a real two-slot promotion', async () => {
  const view=render(<Fixture/>);
  act(()=>calls.find(call=>call.options.duration===380)!.animation.onfinish?.(new Event('finish') as AnimationPlaybackEvent));
  view.rerender(<Fixture id="b"/>);
  await act(async()=>fireEvent.load(document.querySelector('img[src="original:b"]')!));
  fireEvent.click(screen.getByText('close'));
  expect(calls.find(call=>call.options.duration===320)?.frames[1].transform).toBe('translate(-130px,-245px) scale(0.125)');
});
it('uses a short fade/scale when the last tile is off screen', () => {
  render(<Fixture/>);document.querySelector('#test-gallery')?.remove();
  fireEvent.click(screen.getByText('close'));
  expect(calls.find(call=>call.options.fill==='forwards' && call.options.duration===180)?.frames[1]).toEqual({transform:'scale(.96)',opacity:0});
});
it('opens and closes instantly under reduced motion', () => {
  vi.stubGlobal('matchMedia',()=>({matches:true}));
  const onClose=vi.fn();render(<Fixture onClose={onClose}/>);
  fireEvent.click(screen.getByText('close'));
  expect(calls).toHaveLength(0);expect(onClose).toHaveBeenCalledOnce();
});
