import {act,cleanup,fireEvent,render,screen,within} from '@testing-library/react';
import {useState} from 'react';
import {afterEach,expect,it,vi} from 'vitest';
import {closeVisibleShade,useSectionShade} from './SectionShade';
import {TopBar} from './TopBar';

afterEach(cleanup);

type Kind='game'|'manga'|'movie';
const OPTIONS=[{value:'game' as const,label:'게임'},{value:'manga' as const,label:'만화'},{value:'movie' as const,label:'영화'}];

function Screen({onPick,onOutside}:{onPick?(value:Kind):void;onOutside?():void}) {
  const [value,setValue]=useState<Kind>('game');
  const sections=useSectionShade<Kind>({label:'컬렉션 유형',options:OPTIONS,value,onChange:next=>{setValue(next);onPick?.(next);}});
  return <section>
    <TopBar barRef={sections.barRef} title={sections.title('컬렉션')}/>
    {sections.shade}
    <div data-testid="list">{sections.inline}<p>작품</p></div>
    <button type="button" onClick={onOutside}>바깥</button>
  </section>;
}
const list=()=>screen.getByTestId('list');
const topBar=()=>document.querySelector('header.top-bar') as HTMLElement;
const shade=()=>document.querySelector('.section-shade') as HTMLElement|null;
/** jsdom has no layout: a list scrolled past its first row is away, one at the top is not. */
const scrollTo=(top:number)=>{list().scrollTop=top;fireEvent.scroll(list());};
const shadeRadio=(name:string)=>within(shade()!).getByRole('radio',{name,hidden:true});

it('puts the bar in the list and shows the plain title at the top',()=>{
  render(<Screen/>);
  const bar=list().firstElementChild as HTMLElement;
  expect(bar.classList.contains('ui-section-bar--inline')).toBe(true);
  expect(within(bar).getByRole('radiogroup',{name:'컬렉션 유형'})).toBeTruthy();
  expect(screen.getByRole('heading',{name:'컬렉션'})).toBeTruthy();
  expect(screen.queryByRole('button',{name:/컬렉션 · 게임/})).toBeNull();
  expect(shade()).toBeNull();
});

it('names the current section in the title once the bar has scrolled away',()=>{
  render(<Screen/>);
  scrollTo(300);
  const title=screen.getByRole('button',{name:'컬렉션 · 게임'});
  expect(title.getAttribute('aria-expanded')).toBe('false');
  // The closed shade is mounted but out of reach.
  expect(shade()!.getAttribute('aria-hidden')).toBe('true');
  expect(screen.getAllByRole('radiogroup',{name:'컬렉션 유형'})).toHaveLength(1);
  scrollTo(0);
  expect(screen.queryByRole('button',{name:/컬렉션 · /})).toBeNull();
  expect(screen.getByRole('heading',{name:'컬렉션'})).toBeTruthy();
});

it('opens the shade from the title and closes it on a pick',()=>{
  const onPick=vi.fn();
  render(<Screen onPick={onPick}/>);
  scrollTo(300);
  fireEvent.click(screen.getByRole('button',{name:'컬렉션 · 게임'}));
  expect(shade()!.classList.contains('is-open')).toBe(true);
  expect(shade()!.hasAttribute('aria-hidden')).toBe(false);
  expect(screen.getByRole('button',{name:'컬렉션 · 게임'}).getAttribute('aria-expanded')).toBe('true');
  fireEvent.click(shadeRadio('만화'));
  expect(onPick).toHaveBeenCalledWith('manga');
  expect(shade()!.classList.contains('is-open')).toBe(false);
  expect(screen.getByRole('button',{name:'컬렉션 · 만화'})).toBeTruthy();
  // Both copies show the same section.
  expect(within(list()).getByRole('radio',{name:'만화'}).getAttribute('aria-checked')).toBe('true');
});

it('closes on a list scroll, a tap outside, Escape and Back',()=>{
  const onOutside=vi.fn();
  render(<Screen onOutside={onOutside}/>);
  scrollTo(300);
  const open=()=>{fireEvent.click(screen.getByRole('button',{name:/컬렉션 · /}));expect(shade()!.classList.contains('is-open')).toBe(true);};
  const closed=()=>expect(shade()!.classList.contains('is-open')).toBe(false);
  open();scrollTo(320);closed();
  // The closing tap does nothing else; the next one does.
  open();fireEvent.pointerDown(screen.getByRole('button',{name:'바깥'}));closed();
  fireEvent.click(screen.getByRole('button',{name:'바깥'}));expect(onOutside).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button',{name:'바깥'}));expect(onOutside).toHaveBeenCalledTimes(1);
  open();fireEvent.keyDown(document,{key:'Escape'});closed();
  open();let consumed=false;act(()=>{consumed=closeVisibleShade();});expect(consumed).toBe(true);closed();
  expect(closeVisibleShade()).toBe(false);
});

it('follows a pull down the top bar and opens only past half its height',()=>{
  render(<Screen/>);
  scrollTo(300);
  Object.defineProperty(shade()!,'offsetHeight',{configurable:true,value:40});
  const pull=(dy:number,pointerId:number)=>{
    fireEvent.pointerDown(topBar(),{pointerId,isPrimary:true,button:0,clientX:200,clientY:10});
    fireEvent.pointerMove(topBar(),{pointerId,clientX:200,clientY:10+dy});
  };
  // A short pull follows the finger, then springs back.
  pull(15,1);
  expect(shade()!.classList.contains('is-dragging')).toBe(true);
  expect(shade()!.style.transform).toBe('translateY(-25px)');
  fireEvent.pointerUp(topBar(),{pointerId:1,clientX:200,clientY:25});
  expect(shade()!.classList.contains('is-dragging')).toBe(false);
  expect(shade()!.classList.contains('is-open')).toBe(false);
  expect(shade()!.style.transform).toBe('');
  // Past half its height it opens; the finger never drags it below its full height.
  pull(90,2);
  expect(shade()!.style.transform).toBe('translateY(0px)');
  fireEvent.pointerUp(topBar(),{pointerId:2,clientX:200,clientY:100});
  expect(shade()!.classList.contains('is-open')).toBe(true);
});

it('leaves a sideways drag and a pull at the top alone',()=>{
  render(<Screen/>);
  // At the top the bar is in view: nothing to pull.
  fireEvent.pointerDown(topBar(),{pointerId:1,isPrimary:true,button:0,clientX:200,clientY:10});
  fireEvent.pointerMove(topBar(),{pointerId:1,clientX:200,clientY:90});
  fireEvent.pointerUp(topBar(),{pointerId:1,clientX:200,clientY:90});
  expect(shade()).toBeNull();
  scrollTo(300);
  fireEvent.pointerDown(topBar(),{pointerId:2,isPrimary:true,button:0,clientX:200,clientY:10});
  fireEvent.pointerMove(topBar(),{pointerId:2,clientX:290,clientY:20});
  fireEvent.pointerMove(topBar(),{pointerId:2,clientX:290,clientY:90});
  fireEvent.pointerUp(topBar(),{pointerId:2,clientX:290,clientY:90});
  expect(shade()!.classList.contains('is-dragging')).toBe(false);
  expect(shade()!.classList.contains('is-open')).toBe(false);
});

it('does not count a pull that ends on the title as a tap',()=>{
  render(<Screen/>);
  scrollTo(300);
  Object.defineProperty(shade()!,'offsetHeight',{configurable:true,value:40});
  const title=screen.getByRole('button',{name:'컬렉션 · 게임'});
  fireEvent.pointerDown(title,{pointerId:1,isPrimary:true,button:0,clientX:50,clientY:10});
  fireEvent.pointerMove(title,{pointerId:1,clientX:50,clientY:60});
  fireEvent.pointerUp(title,{pointerId:1,clientX:50,clientY:60});
  fireEvent.click(title);
  expect(shade()!.classList.contains('is-open')).toBe(true);
});
