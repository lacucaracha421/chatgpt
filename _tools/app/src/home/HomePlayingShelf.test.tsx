import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { HomePlayingShelf } from './HomePlayingShelf';

afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

it('pages the clipped cases with the shared shelf arrows while a click still opens the work', () => {
  vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: true })));
  const onOpen = vi.fn();
  const { container } = render(<HomePlayingShelf onOpen={onOpen} works={Array.from({ length: 6 }, (_, i) => ({
    id: `${i}`, name: `Game ${i}`, platform: 'PC', score: null, case: () => <span>case art</span>,
  }))} />);
  const track = container.querySelector<HTMLElement>('.home-shelf__track')!;
  expect(track.querySelector('.home-playing__track')).toBeTruthy();
  Object.defineProperties(track, { clientWidth: { value: 400 }, scrollWidth: { value: 1000 } });
  fireEvent.scroll(track);
  expect(screen.queryByRole('button', { name: '이전 지금 하는 중' })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: '다음 지금 하는 중' }));
  expect(track.scrollLeft).toBe(360);
  fireEvent.scroll(track);
  expect(screen.getByRole('button', { name: '이전 지금 하는 중' })).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Game 5 열기' }));
  expect(onOpen).toHaveBeenCalledWith('5');
});

it('reserves gutters and fits complete cards before paint, then pages by complete cards', () => {
  vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: true })));
  let width = 660;
  const styles = window.getComputedStyle;
  vi.spyOn(window, 'getComputedStyle').mockImplementation(element => {
    const style = styles(element);
    if (element.classList.contains('home-shelf')) return { ...style, paddingLeft: '36px', paddingRight: '36px' } as CSSStyleDeclaration;
    if (element.classList.contains('home-playing__track')) return { ...style, paddingLeft: '16px', paddingRight: '16px', columnGap: '24px' } as CSSStyleDeclaration;
    return style;
  });
  vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockReturnValue(120);
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockImplementation(function(this: HTMLElement) {
    return this.classList.contains('home-shelf') ? width : parseFloat(this.style.width) || 0;
  });
  vi.spyOn(HTMLElement.prototype, 'scrollWidth', 'get').mockReturnValue(872);
  let resize!: ResizeObserverCallback;
  vi.stubGlobal('ResizeObserver', class {
    constructor(callback: ResizeObserverCallback) { resize = callback; }
    observe() {} disconnect() {}
  });
  const { container } = render(<HomePlayingShelf onOpen={() => undefined} works={Array.from({ length: 6 }, (_, i) => ({
    id: `${i}`, name: `Long game title ${i}`, platform: 'Nintendo Switch 2', score: null, case: () => <span>art</span>,
  }))} />);
  const track = container.querySelector<HTMLElement>('.home-shelf__track')!;
  expect(container.querySelector('.home-shelf--whole-cards')).toBeTruthy();
  expect(track.style.width).toBe('584px'); // Four 120px cards, three 24px gaps, two 16px insets.
  fireEvent.click(screen.getByRole('button', { name: '다음 지금 하는 중' }));
  expect(track.scrollLeft).toBe(288); // The final two-card step ends on the last complete card.
  width = 516;
  fireEvent.scroll(track); // Uses the same synchronous measurement as the resize observer.
  expect(track.style.width).toBe('440px');
  expect(resize).toBeTypeOf('function');
});
