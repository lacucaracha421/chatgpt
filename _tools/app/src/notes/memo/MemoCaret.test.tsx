import { useState } from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, it, vi } from 'vitest';
import { revealCaretIn } from '../model';
import { MEMO_CARET_MARGIN, MemoEditor, sizeArea } from './MemoEditor';

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

const rect = (top: number, bottom: number) => ({ top, bottom, height: bottom - top, left: 0, right: 500, width: 500, x: 0, y: top, toJSON: () => ({}) }) as DOMRect;
/** A pane whose scroll offset jsdom keeps, sized 0–400 on screen. */
function pane(scrollTop: number) {
  const element = document.createElement('div');
  element.style.overflowY = 'auto';
  let offset = scrollTop;
  Object.defineProperty(element, 'scrollTop', { configurable: true, get: () => offset, set: (value: number) => { offset = Math.max(0, value); } });
  Object.defineProperty(element, 'scrollHeight', { configurable: true, get: () => 2000 });
  Object.defineProperty(element, 'clientHeight', { configurable: true, get: () => 400 });
  vi.spyOn(element, 'getBoundingClientRect').mockReturnValue(rect(0, 400));
  document.body.append(element);
  return element;
}
/** Places the caret's line `top` px below the textarea's top (the mirror's marker offset). */
function caretAt(top: number) {
  vi.spyOn(HTMLElement.prototype, 'offsetTop', 'get').mockReturnValue(top);
  vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockReturnValue(24);
}

it('leaves the view alone while the caret line is visible, even when the field runs past the pane', () => {
  const box = pane(500); const area = document.createElement('textarea'); box.append(area);
  vi.spyOn(area, 'getBoundingClientRect').mockReturnValue(rect(-300, 900));
  caretAt(500); // caret line at 200–224 on screen
  revealCaretIn(box, area, MEMO_CARET_MARGIN);
  expect(box.scrollTop).toBe(500);
});

it('scrolls only as far as needed when the caret line would leave the bottom or the top', () => {
  const box = pane(500); const area = document.createElement('textarea'); box.append(area);
  vi.spyOn(area, 'getBoundingClientRect').mockReturnValue(rect(-300, 900));
  caretAt(690); // caret line at 390–414: 30px past the bottom margin edge (384)
  revealCaretIn(box, area, MEMO_CARET_MARGIN);
  expect(box.scrollTop).toBe(530);
  caretAt(300); // caret line at 0–24: 16px above the top margin edge
  revealCaretIn(box, area, MEMO_CARET_MARGIN);
  expect(box.scrollTop).toBe(514);
});

it('keeps the scrolled pane in place while the field collapses to measure its height', () => {
  const box = pane(800); const area = document.createElement('textarea'); box.append(area);
  // The collapse clamps the pane's offset as the browser does; the resize must not keep that.
  Object.defineProperty(area, 'scrollHeight', { configurable: true, get: () => { if (area.style.height === '0px') box.scrollTop = 0; return 1200; } });
  sizeArea(area);
  expect(area.style.height).toBe('1200px');
  expect(box.scrollTop).toBe(800);
});

function editor(touch: boolean) {
  function Harness() {
    const [body, setBody] = useState('first line\nsecond line');
    return <MemoEditor noteId="one" body={body} touch={touch} onChange={next => { setBody(next); }}/>;
  }
  const box = pane(500);
  render(<Harness/>, { container: box });
  const area = screen.getByRole('textbox', { name: '메모 본문' }) as HTMLTextAreaElement;
  vi.spyOn(area, 'getBoundingClientRect').mockReturnValue(rect(-300, 900));
  return { box, area };
}

it('PC typing keeps the view still while the caret line is visible and follows it minimally past the edge', () => {
  const { box, area } = editor(false);
  caretAt(500);
  fireEvent.change(area, { target: { value: 'first line\nsecond line!' } });
  expect(box.scrollTop).toBe(500);
  caretAt(690);
  fireEvent.change(area, { target: { value: 'first line\nsecond line!\n' } });
  expect(box.scrollTop).toBe(530);
});

it('leaves tablet typing to the tablet pane (keyboard avoidance) instead of following the caret here', () => {
  const { box, area } = editor(true);
  caretAt(690);
  fireEvent.change(area, { target: { value: 'first line\nsecond line!\n' } });
  expect(box.scrollTop).toBe(500);
});

it('shows 섹션 추가 as its own button after the last section', async () => {
  function Harness() {
    const [body, setBody] = useState('top\n## A\na\n## B\nb');
    return <MemoEditor noteId="one" body={body} onChange={next => { setBody(next); }}/>;
  }
  render(<Harness/>);
  const add = screen.getByRole('button', { name: '섹션 추가' });
  expect(add).toHaveClass('ui-button--secondary');
  expect(add.querySelector('svg')).not.toBeNull();
  const sections = document.querySelectorAll('.memo-section');
  expect(sections[sections.length - 1]!.compareDocumentPosition(add) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  await userEvent.click(add);
  expect(screen.getByRole('textbox', { name: '섹션 이름' })).toBeInTheDocument();
});
