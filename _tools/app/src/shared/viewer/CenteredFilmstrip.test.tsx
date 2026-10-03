import {act, cleanup, fireEvent, render, screen} from '@testing-library/react';
import {useState} from 'react';
import {afterEach, beforeEach, expect, it, vi} from 'vitest';
import {CenteredFilmstrip, FILMSTRIP_DWELL_MS} from './CenteredFilmstrip';
const items = Array.from({length: 1000}, (_, i) => ({id: `${i}`, width: i % 2 ? 200 : 100, height: 100}));
const thumb = () => <span/>;
beforeEach(() => {vi.stubGlobal('matchMedia', vi.fn(() => ({matches:false, addEventListener:vi.fn(), removeEventListener:vi.fn()}))); vi.useFakeTimers();});
afterEach(() => {cleanup(); vi.useRealTimers(); vi.unstubAllGlobals();});
it('bounds the mounted window, preserves aspect ratios and shares a fixed centre slot', () => {
  render(<CenteredFilmstrip items={items} index={500} onIndex={() => {}} renderThumbnail={thumb}/>);
  const strip = screen.getByRole('navigation');
  expect(strip.querySelectorAll('button').length).toBeLessThan(25);
  expect(screen.getByRole('button', {name:'501번째 자산 보기'}).style.width).toBe('124px');
  expect(screen.getByRole('button', {name:'502번째 자산 보기'}).style.width).toBe('248px');
  expect(strip.querySelectorAll('.centered-filmstrip__slot i')).toHaveLength(2);
});
it('retargets the spring for keyboard selection without replacing the rail', () => {
  const onIndex = vi.fn();
  const props = {items, onIndex, renderThumbnail:thumb};
  const view = render(<CenteredFilmstrip {...props} index={500}/>);
  const rail = document.querySelector<HTMLElement>('.centered-filmstrip__rail')!;
  const from = rail.style.transform;
  fireEvent.keyDown(screen.getByRole('navigation'), {key:'ArrowRight'});
  expect(onIndex).toHaveBeenCalledWith(501);
  view.rerender(<CenteredFilmstrip {...props} index={501}/>);
  expect(rail.style.transform).toBe(from);
  act(() => vi.advanceTimersByTime(2000));
  expect(rail.style.transform).not.toBe(from);
  expect(document.querySelector('.centered-filmstrip__rail')).toBe(rail);
});
it('switches instantly with reduced motion and grows through a transform class', () => {
  vi.stubGlobal('matchMedia', () => ({matches:true}));
  const props = {items, onIndex:vi.fn(), renderThumbnail:thumb};
  const view = render(<CenteredFilmstrip {...props} index={500}/>);
  const rail = document.querySelector<HTMLElement>('.centered-filmstrip__rail')!;
  const from = rail.style.transform;
  view.rerender(<CenteredFilmstrip {...props} index={501} grown/>);
  expect(rail.style.transform).not.toBe(from);
  expect(screen.getByRole('navigation')).toHaveClass('is-grown');
});
it('drags with inertia, snaps and suppresses the drag click', () => {
  const onIndex = vi.fn();
  render(<CenteredFilmstrip items={items} index={500} grown onIndex={onIndex} renderThumbnail={thumb}/>);
  const strip = screen.getByRole('navigation');
  const button = screen.getByRole('button', {name:'501번째 자산 보기'});
  fireEvent.pointerDown(button, {pointerId:1, clientX:200, clientY:20});
  act(() => vi.advanceTimersByTime(40));
  fireEvent.pointerMove(strip, {pointerId:1, clientX:0, clientY:20});
  fireEvent.pointerUp(strip, {pointerId:1, clientX:0, clientY:20});
  fireEvent.click(button);
  // The main image follows once the flung rail settles, not on every item it passes.
  act(() => vi.advanceTimersByTime(2000));
  expect(onIndex.mock.calls.some(([i]) => i > 500)).toBe(true);
  expect(onIndex).not.toHaveBeenCalledWith(500);
  expect(strip.querySelectorAll('button').length).toBeLessThan(25);
});
it('keeps a wheel gesture latched through the rail end', () => {
  const parent = vi.fn();
  render(<div onWheel={parent}><CenteredFilmstrip items={items.slice(0, 3)} index={1} onIndex={() => {}} renderThumbnail={thumb}/></div>);
  const strip = screen.getByRole('navigation');
  Object.defineProperties(strip, {clientWidth:{value:400}, scrollWidth:{value:736}});
  const first = new WheelEvent('wheel', {deltaX:1000, bubbles:true, cancelable:true});
  fireEvent(strip, first);
  const end = new WheelEvent('wheel', {deltaX:100, bubbles:true, cancelable:true});
  fireEvent(strip, end);
  expect(first.defaultPrevented).toBe(true);
  expect(end.defaultPrevented).toBe(true);
  expect(parent).not.toHaveBeenCalled();
});
it('shows only an item that holds the slot or where a fast drag settles', () => {
  const onIndex = vi.fn();
  render(<CenteredFilmstrip items={items} index={500} grown onIndex={onIndex} renderThumbnail={thumb}/>);
  const strip = screen.getByRole('navigation');
  fireEvent.pointerDown(strip, {pointerId:1, clientX:900, clientY:20});
  for (let x = 860; x >= 100; x -= 40) { act(() => vi.advanceTimersByTime(16)); fireEvent.pointerMove(strip, {pointerId:1, clientX:x, clientY:20}); }
  expect(onIndex).not.toHaveBeenCalled();
  act(() => vi.advanceTimersByTime(FILMSTRIP_DWELL_MS));
  expect(onIndex).toHaveBeenCalledTimes(1);
  const held = onIndex.mock.calls[0][0];
  expect(held).toBeGreaterThan(500);
  fireEvent.pointerMove(strip, {pointerId:1, clientX:20, clientY:20});
  fireEvent.pointerUp(strip, {pointerId:1, clientX:20, clientY:20});
  act(() => vi.advanceTimersByTime(3000));
  expect(onIndex.mock.calls.length).toBeLessThanOrEqual(3);
  expect(onIndex.mock.calls[onIndex.mock.calls.length - 1]![0]).toBeGreaterThanOrEqual(held);
});
it.each(['click', 'keyboard', 'cancel'] as const)('invalidates a pending drag dwell on %s', action => {
  const onIndex = vi.fn();
  function Harness() {
    const [index, setIndex] = useState(0);
    return <CenteredFilmstrip items={Array.from({length:5}, (_, i) => ({id:`${i}`}))} index={index} grown renderThumbnail={thumb}
      onIndex={next => { onIndex(next); setIndex(next); }}/>;
  }
  render(<Harness/>);
  const strip = screen.getByRole('navigation');
  fireEvent.pointerDown(strip, {pointerId:1, clientX:200, clientY:20});
  fireEvent.pointerMove(strip, {pointerId:1, clientX:70, clientY:20});
  if (action === 'cancel') {
    fireEvent.pointerCancel(strip, {pointerId:1});
  } else {
    fireEvent.pointerUp(strip, {pointerId:1});
    fireEvent.click(strip); // Suppress the click generated by the drag itself.
    if (action === 'click') {
      const button = screen.getByRole('button', {name:'3번째 자산 보기'});
      fireEvent.pointerDown(button, {pointerId:2, clientX:200, clientY:20});
      fireEvent.pointerUp(button, {pointerId:2});
      fireEvent.click(button);
    } else {
      fireEvent.keyDown(strip, {key:'ArrowLeft'});
    }
  }
  act(() => vi.advanceTimersByTime(FILMSTRIP_DWELL_MS + 2000));
  if (action === 'cancel') expect(onIndex).not.toHaveBeenCalled();
  else {
    expect(onIndex).toHaveBeenCalledExactlyOnceWith(action === 'click' ? 2 : 0);
    expect(screen.getByRole('button', {name:action === 'click' ? '3번째 자산 보기' : '1번째 자산 보기'})).toHaveAttribute('aria-current', 'true');
  }
});
