// Exercise the same component and gesture contract in the tablet's test environment.
import '../src/shared/ui/useHorizontalWheel.test';
import '../src/shared/ui/ShelfScroller.test';
import {cleanup, fireEvent, render} from '@testing-library/react';
import {afterEach, expect, it, vi} from 'vitest';
import {FolderShelf} from './FolderCards';

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
it('uses the shared wheel latch and touch containment in the tablet folder strip', () => {
  vi.stubGlobal('matchMedia', vi.fn(() => ({matches:true})));
  const {container} = render(<FolderShelf label="폴더" cards={[<button key="one">캐릭터</button>]}/>);
  const strip = container.querySelector<HTMLElement>('.home-shelf__track')!;
  Object.defineProperties(strip, {clientWidth:{value:200}, scrollWidth:{value:800}});
  strip.scrollLeft = 590;
  const send = (at:number) => {
    const event = new WheelEvent('wheel', {deltaY:30, bubbles:true, cancelable:true});
    Object.defineProperty(event, 'timeStamp', {value:at});
    fireEvent(strip, event);
    return event.defaultPrevented;
  };
  expect(send(0)).toBe(true);
  expect(strip.scrollLeft).toBe(600);
  expect(send(100)).toBe(true);
  expect(send(400)).toBe(false);
  expect(strip.style.overscrollBehaviorX).toBe('contain');
});
