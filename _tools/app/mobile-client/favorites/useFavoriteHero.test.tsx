import {act,cleanup,fireEvent,render,screen,waitFor} from '@testing-library/react';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {Overlay} from '../Overlay';
import {useFavoriteHero} from './useFavoriteHero';

function Harness() {
  const hero=useFavoriteHero();
  return <>
    <div ref={hero.grid}><Overlay open retainLayout covered={!!hero.selected} title="목록" onClose={hero.reset}>
      <button data-favorite-card="a" onClick={()=>hero.open('a')}><span className="favorite-portrait">카드</span></button>
    </Overlay></div>
    <div ref={hero.detail}><Overlay open={!!hero.displayed} preparing={!!hero.pending} noMotion={hero.noMotion} title="상세" onClose={hero.close}>
      <span className="favorite-portrait">초상</span>
    </Overlay></div>
    <button onClick={hero.ready}>준비 완료</button><button onClick={hero.close}>Back</button>
  </>;
}

const originalTransition=Object.getOwnPropertyDescriptor(document,'startViewTransition');
beforeEach(()=>{Object.defineProperty(document,'startViewTransition',{configurable:true,writable:true,value:vi.fn()});});
afterEach(()=>{
  cleanup();vi.restoreAllMocks();vi.unstubAllGlobals();
  if(originalTransition)Object.defineProperty(document,'startViewTransition',originalTransition);
  else Reflect.deleteProperty(document,'startViewTransition');
});

it('keeps the grid until ready and shares one portrait for both open and Back',async()=>{
  vi.spyOn(HTMLElement.prototype,'getBoundingClientRect').mockReturnValue({x:0,y:0,top:0,left:0,right:200,bottom:200,width:200,height:200,toJSON:()=>({})});
  const transitions:{commit:()=>void;finish():void;finished:Promise<void>}[]=[];
  vi.spyOn(document,'startViewTransition').mockImplementation(((commit:()=>void)=>{
    let finish!:()=>void;
    const finished=new Promise<void>(resolve=>{finish=resolve;});
    transitions.push({commit,finish,finished});
    return {ready:Promise.resolve(),finished,updateCallbackDone:Promise.resolve(),skipTransition:finish};
  }) as typeof document.startViewTransition);
  render(<Harness/>);
  const card=screen.getByText('카드');
  fireEvent.click(card);
  expect(screen.getByRole('dialog',{name:'목록'})).toBeTruthy();
  expect(screen.queryByRole('dialog',{name:'상세'})).toBeNull();
  fireEvent.click(screen.getByText('준비 완료'));
  await waitFor(()=>expect(transitions).toHaveLength(1));
  expect(card.hasAttribute('data-view-hero')).toBe(true);
  expect(document.documentElement.getAttribute('data-area-view-transition')).toBe('hero');
  act(()=>transitions[0].commit());
  expect(screen.getByRole('dialog',{name:'상세'})).toBeTruthy();
  expect(screen.getByText('초상').hasAttribute('data-view-hero')).toBe(true);
  await act(async()=>{transitions[0].finish();await transitions[0].finished;});
  fireEvent.click(screen.getByText('Back'));
  expect(transitions).toHaveLength(2);
  act(()=>transitions[1].commit());
  expect(screen.getByRole('dialog',{name:'목록'})).toBeTruthy();
  expect(card.hasAttribute('data-view-hero')).toBe(true);
  await act(async()=>{transitions[1].finish();await transitions[1].finished;});
  expect(card.hasAttribute('data-view-hero')).toBe(false);
});

it('cancels a prepared opening before a late browser callback can reveal the detail',async()=>{
  vi.spyOn(HTMLElement.prototype,'getBoundingClientRect').mockReturnValue({x:0,y:0,top:0,left:0,right:200,bottom:200,width:200,height:200,toJSON:()=>({})});
  let commit!:()=>void,finish!:()=>void;
  const finished=new Promise<void>(resolve=>{finish=resolve;});
  vi.spyOn(document,'startViewTransition').mockImplementation(((callback:()=>void)=>{
    commit=callback;
    return {ready:Promise.resolve(),finished,updateCallbackDone:Promise.resolve(),skipTransition:finish};
  }) as typeof document.startViewTransition);
  render(<Harness/>);
  fireEvent.click(screen.getByText('카드'));
  fireEvent.click(screen.getByText('준비 완료'));
  await waitFor(()=>expect(commit).toBeTypeOf('function'));
  fireEvent.click(screen.getByText('Back'));
  await act(async()=>{commit();await finished;});
  expect(screen.getByRole('dialog',{name:'목록'})).toBeTruthy();
  expect(screen.queryByRole('dialog',{name:'상세'})).toBeNull();
  expect(document.documentElement.hasAttribute('data-area-view-transition')).toBe(false);
});
