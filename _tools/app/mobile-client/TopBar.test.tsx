import { act, cleanup, render, screen,within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { LoadingLine, TopBar } from './TopBar';

afterEach(() => { cleanup(); vi.useRealTimers(); });
it('uses the shared 600 ms delay and 400 ms minimum for the loading line', () => {
  vi.useFakeTimers();
  const view = render(<LoadingLine label="목록 불러오는 중"/>);
  act(() => vi.advanceTimersByTime(599));
  expect(screen.queryByRole('status')).toBeNull();
  act(() => vi.advanceTimersByTime(1));
  expect(screen.getByRole('status', {name: '목록 불러오는 중'})).toBeTruthy();
  view.rerender(<LoadingLine label={false}/>);
  act(() => vi.advanceTimersByTime(399));
  expect(screen.getByRole('status', {name: '목록 불러오는 중'})).toBeTruthy();
  act(() => vi.advanceTimersByTime(1));
  expect(screen.queryByRole('status')).toBeNull();
});


it('formats numeric header counts with thousands separators', () => {
 render(<TopBar title="폴더" count={1020}/>);
 expect(screen.getByText('1,020')).toBeTruthy();
});

it.each(['홈','에셋','컬렉션','카탈로그','메모','작가','설정','발매 캘린더'])('%s ends with the fixed Find and More slots',title=>{
 const view=render(<TopBar title={title}/>);
 const buttons=within(view.container.querySelector('header')!).getAllByRole('button');
 expect(buttons.slice(-2).map(button=>button.getAttribute('aria-label'))).toEqual(['찾기','더보기']);
});
it('keeps the parent and title inline and its parent tappable',()=>{
 render(<TopBar crumbs={<button>홈 ›</button>} title="발매 캘린더" count={130}/>);
 expect(document.querySelector('.top-bar__titles--stacked')).toBeNull();
 expect(screen.getByRole('button',{name:'홈 ›'}).closest('.top-bar__titles')).toBe(screen.getByRole('heading').closest('.top-bar__titles'));
});
