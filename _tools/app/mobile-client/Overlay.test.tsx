import {cleanup, fireEvent, render, screen} from '@testing-library/react';
import {afterEach, expect, it, vi} from 'vitest';
import {Overlay} from './Overlay';

afterEach(cleanup);
const header=()=>document.querySelector('.mobile-overlay__header')!;
const swipe=(dx:number,dy:number,cancel=false)=>{
  fireEvent.pointerDown(header(),{isPrimary:true,pointerId:1,button:0,clientX:30,clientY:30});
  fireEvent.pointerMove(header(),{isPrimary:true,pointerId:1,clientX:30+dx,clientY:30+dy});
  (cancel?fireEvent.pointerCancel:fireEvent.pointerUp)(header(),{isPrimary:true,pointerId:1,clientX:30+dx,clientY:30+dy});
};
it('dismisses from the header, handle, close action or dim area; content scrolling is separate',()=>{
  const onClose=vi.fn();
  render(<Overlay open title="쇼케이스" count={12} onClose={onClose}><div data-testid="scroll"><button>작품</button></div></Overlay>);
  expect(screen.getByRole('dialog',{name:'쇼케이스'}).getAttribute('aria-modal')).toBe('true');
  swipe(2,80);expect(onClose).toHaveBeenCalledTimes(1);
  swipe(100,70);swipe(0,20);swipe(0,90,true);expect(onClose).toHaveBeenCalledTimes(1);
  fireEvent.pointerDown(screen.getByTestId('scroll'),{isPrimary:true,pointerId:2,clientY:0});
  fireEvent.pointerUp(screen.getByTestId('scroll'),{isPrimary:true,pointerId:2,clientY:100});expect(onClose).toHaveBeenCalledTimes(1);
  fireEvent.pointerDown(document.querySelector('.mobile-overlay__grab')!,{isPrimary:true,pointerId:3,clientX:30,clientY:30});
  fireEvent.pointerUp(header(),{isPrimary:true,pointerId:3,clientX:30,clientY:120});expect(onClose).toHaveBeenCalledTimes(2);
  fireEvent.click(screen.getByRole('button',{name:'쇼케이스 닫기'}));
  fireEvent.click(document.querySelector('.mobile-overlay__scrim')!);expect(onClose).toHaveBeenCalledTimes(4);
});
it('retains the exact scrolling content while a work covers the overlay',()=>{
  const props={open:true,title:'신간',onClose:vi.fn()};
  const content=<div data-testid="scroll"><button>작품</button></div>;
  const view=render(<Overlay {...props}>{content}</Overlay>);
  const scroll=screen.getByTestId('scroll');scroll.scrollTop=210;
  view.rerender(<Overlay {...props} covered>{content}</Overlay>);
  expect(screen.queryByRole('dialog')).toBeNull();expect(screen.getByTestId('scroll')).toBe(scroll);
  view.rerender(<Overlay {...props}>{content}</Overlay>);
  expect(screen.getByRole('dialog',{name:'신간'})).toBeTruthy();expect(scroll.scrollTop).toBe(210);
});
it('keeps keyboard focus inside and returns to the shortcut without scrolling it',()=>{
  const onClose=vi.fn();
  const view=render(<><button>바로가기</button><Overlay open={false} title="쇼케이스" onClose={onClose}><button>작품</button></Overlay></>);
  const opener=screen.getByRole('button',{name:'바로가기'});opener.focus();
  view.rerender(<><button>바로가기</button><Overlay open title="쇼케이스" onClose={onClose}><button>작품</button></Overlay></>);
  const close=screen.getByRole('button',{name:'쇼케이스 닫기'}),work=screen.getByRole('button',{name:'작품'});
  expect(document.activeElement).toBe(close);
  fireEvent.keyDown(close,{key:'Tab',shiftKey:true});expect(document.activeElement).toBe(work);
  fireEvent.keyDown(work,{key:'Tab'});expect(document.activeElement).toBe(close);
  view.rerender(<><button>바로가기</button><Overlay open={false} title="쇼케이스" onClose={onClose}><button>작품</button></Overlay></>);
  expect(document.activeElement).toBe(opener);
});
