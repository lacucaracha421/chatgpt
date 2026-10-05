import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { HomePlayingShelf } from './HomePlayingShelf';

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

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
