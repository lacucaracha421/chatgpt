import {cleanup, fireEvent, render, screen} from '@testing-library/react';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import type {Asset} from './types';
import {ViewerFilmstrip} from './ViewerFilmstrip';

const assets = Array.from({length: 100}, (_, index) => ({
  id: `asset-${index}`,
  kind: 'image',
  preview: `https://test.invalid/thumb-${index}`,
}) satisfies Asset);

beforeEach(() => {
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    value: vi.fn(() => ({matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn()})),
  });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('ViewerFilmstrip', () => {
  it('renders a bounded window and grows it when the native scroller reaches an edge', () => {
    render(<ViewerFilmstrip items={assets} index={50} onIndex={() => {}}/>);
    const strip = screen.getByRole('navigation', {name: '주변 자산'});
    expect(strip.querySelectorAll('button')).toHaveLength(61);

    Object.defineProperties(strip, {
      clientWidth: {configurable: true, value: 400},
      scrollWidth: {configurable: true, value: 4_000},
      scrollLeft: {configurable: true, value: 3_600},
    });
    fireEvent.scroll(strip);

    expect(strip.querySelectorAll('button').length).toBeGreaterThan(61);
  });

  it('smoothly centres the current thumbnail when the current item changes', () => {
    const scrollTo = vi.fn();
    const view = render(<ViewerFilmstrip items={assets} index={50} onIndex={() => {}}/>);
    const strip = screen.getByRole('navigation', {name: '주변 자산'});
    Object.defineProperty(strip, 'clientWidth', {configurable: true, value: 400});
    Object.defineProperty(strip, 'scrollWidth', {configurable: true, value: 4_000});
    Object.defineProperty(strip, 'scrollTo', {configurable: true, value: scrollTo});
    scrollTo.mockClear();

    view.rerender(<ViewerFilmstrip items={assets} index={51} onIndex={() => {}}/>);

    expect(scrollTo).toHaveBeenCalledWith(expect.objectContaining({behavior: 'smooth'}));
  });

  it('does not change the current item after a drag, but a tap jumps to the thumbnail', () => {
    const onIndex = vi.fn();
    render(<ViewerFilmstrip items={assets} index={50} onIndex={onIndex}/>);
    const strip = screen.getByRole('navigation', {name: '주변 자산'});
    const dragged = screen.getByRole('button', {name: '46번째 자산 보기'});

    fireEvent.pointerDown(dragged, {pointerId: 1, clientX: 100, clientY: 20});
    fireEvent.pointerMove(strip, {pointerId: 1, clientX: 60, clientY: 20});
    fireEvent.pointerUp(strip, {pointerId: 1, clientX: 60, clientY: 20});
    fireEvent.click(dragged);
    expect(onIndex).not.toHaveBeenCalled();

    const tapped = screen.getByRole('button', {name: '47번째 자산 보기'});
    fireEvent.pointerDown(tapped, {pointerId: 2, clientX: 100, clientY: 20});
    fireEvent.pointerUp(tapped, {pointerId: 2, clientX: 101, clientY: 20});
    fireEvent.click(tapped);
    expect(onIndex).toHaveBeenCalledWith(46);
  });

  it('reports touch ownership until the finger leaves the strip', () => {
    const onInteractionChange = vi.fn();
    render(<ViewerFilmstrip items={assets} index={50} onIndex={() => {}} onInteractionChange={onInteractionChange}/>);
    const thumb = screen.getByRole('button', {name: '51번째 자산 보기'});

    fireEvent.pointerDown(thumb, {pointerId: 3, clientX: 100, clientY: 20});
    fireEvent.pointerUp(thumb, {pointerId: 3, clientX: 100, clientY: 20});

    expect(onInteractionChange).toHaveBeenNthCalledWith(1, true);
    expect(onInteractionChange).toHaveBeenLastCalledWith(false);
  });
});
