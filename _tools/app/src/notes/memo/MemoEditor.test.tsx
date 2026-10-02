import { useState } from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, it, vi } from 'vitest';
import { MEMO_HOLD_MS, MemoEditor, type MemoEditorProps } from './MemoEditor';
import { MEMO_DRAG_HOLD_MS } from './useMemoSectionDrag';

afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); });
function surface(body: string, options: Partial<MemoEditorProps> = {}) {
  const changes = vi.fn();
  function Harness() {
    const [value, setValue] = useState(body);
    return <div data-testid="memo-pane" style={{ overflowY: 'auto' }}><div data-testid="body">{value}</div><MemoEditor noteId="one" body={value} {...options} onChange={(next, structural) => { changes(next, structural); setValue(next); }}/></div>;
  }
  render(<Harness/>); return changes;
}
const rows = () => screen.getAllByRole('textbox', { name: '메모 본문' }) as HTMLTextAreaElement[];
const texts = () => rows().map(row => row.value);
const body = () => screen.getByTestId('body').textContent;
function dragRects() {
  const sections = [...document.querySelectorAll<HTMLElement>('[data-memo-section]')];
  sections.forEach((section, index) => vi.spyOn(section, 'getBoundingClientRect').mockReturnValue({
    top: 100 + index * 120, bottom: 200 + index * 120, height: 100, left: 0, right: 500, width: 500, x: 0, y: 100 + index * 120, toJSON: () => ({}),
  }));
  return sections.map(section => section.querySelector<HTMLElement>('.memo-section-head')!);
}
const mouse = { pointerType: 'mouse', pointerId: 1, button: 0, clientX: 20, clientY: 110 };
it.each(['text', 'todo'] as const)('reorders %s sections after 4px, previews without saves, and persists once on drop', mode => {
  const line = mode === 'todo' ? '- [ ] ' : '';
  const changes = surface(`${line}top\n## A\n${line}a\n## B\n${line}b\n## C\n${line}c`);
  const heads = dragRects(); const untouched = rows()[1]!;
  fireEvent.pointerDown(heads[0]!, mouse);
  fireEvent.pointerMove(window, { ...mouse, clientY: 113 });
  expect(document.querySelector('.memo-section--dragging')).toBeNull();
  fireEvent.pointerMove(window, { ...mouse, clientY: 114 });
  expect(heads[0]!.closest('section')).toHaveClass('memo-section--dragging');
  fireEvent.pointerMove(window, { ...mouse, clientY: 390 });
  expect(document.querySelector('.memo-section-drop')).toBeInTheDocument();
  expect(heads[1]!.closest('section')!.style.transform).toBe('translateY(-120px)');
  expect(changes).not.toHaveBeenCalled();
  fireEvent.pointerUp(window, { ...mouse, clientY: 390 });
  expect(changes).toHaveBeenCalledExactlyOnceWith(`${line}top\n## B\n${line}b\n## C\n${line}c\n## A\n${line}a`, true);
  expect(screen.getAllByRole('heading').map(head => head.textContent)).toEqual(['B', 'C', 'A']);
  expect(rows()[3]).toBe(untouched);
  expect(document.querySelector('.memo-section-drop')).toBeNull();
});
it('leaves clicks on copy and the section menu working and suppresses the click after dragging a control', async () => {
  const copyText = vi.fn(async () => {});
  const changes = surface('## A\na\n## B\nb', { copyText });
  const heads = dragRects();
  await userEvent.click(within(heads[0]!).getByRole('button', { name: '복사' }));
  expect(copyText).toHaveBeenCalledWith('a');
  await userEvent.click(screen.getByRole('button', { name: 'A 더보기' }));
  expect(await screen.findByRole('menuitem', { name: '아래로' })).toBeInTheDocument();
  await userEvent.keyboard('{Escape}');
  const button = within(heads[0]!).getByRole('button', { name: '복사' });
  fireEvent.pointerDown(button, mouse);
  fireEvent.pointerMove(window, { ...mouse, clientY: 280 });
  fireEvent.pointerUp(window, { ...mouse, clientY: 280 });
  fireEvent.click(button, { detail: 1 });
  expect(copyText).toHaveBeenCalledTimes(1);
  expect(changes).toHaveBeenCalledTimes(1);
  await userEvent.click(within(screen.getByLabelText('메모 섹션')).getByRole('button', { name: 'B' }));
  expect(texts()).toEqual(['b']);
});
it('cancels an active drag with Escape or pointercancel without saving', () => {
  const changes = surface('## A\na\n## B\nb'); const heads = dragRects();
  for (const cancel of ['escape', 'pointercancel']) {
    fireEvent.pointerDown(heads[0]!, mouse);
    fireEvent.pointerMove(window, { ...mouse, clientY: 280 });
    if (cancel === 'escape') fireEvent.keyDown(window, { key: 'Escape' });
    else fireEvent.pointerCancel(window, mouse);
    fireEvent.pointerUp(window, mouse);
    expect(document.querySelector('.memo-section--dragging')).toBeNull();
  }
  expect(changes).not.toHaveBeenCalled(); expect(body()).toBe('## A\na\n## B\nb');
});
it('disables dragging under a section filter and for read-only notes', () => {
  const changes = surface('## A\na\n## B\nb');
  fireEvent.click(within(screen.getByLabelText('메모 섹션')).getByRole('button', { name: 'A' }));
  const head = screen.getByRole('heading', { name: 'A' }).parentElement!;
  fireEvent.pointerDown(head, mouse); fireEvent.pointerMove(window, { ...mouse, clientY: 400 }); fireEvent.pointerUp(window, mouse);
  expect(head).not.toHaveClass('memo-section-head--draggable'); expect(changes).not.toHaveBeenCalled();
  cleanup(); surface('## A\na\n## B\nb', { readOnly: true });
  expect(document.querySelector('.memo-section-head--draggable')).toBeNull();
});
it('keeps touch taps and vertical scrolling, starts at 250ms, and scrolls near the pane edge during drag', () => {
  vi.useFakeTimers();
  const changes = surface('## A\na\n## B\nb\n## C\nc', { touch: true });
  const heads = dragRects(); const pane = screen.getByTestId('memo-pane');
  Object.defineProperties(pane, { scrollHeight: { value: 2000 }, clientHeight: { value: 400 } });
  vi.spyOn(pane, 'getBoundingClientRect').mockReturnValue({ top: 0, bottom: 400, height: 400 } as DOMRect);
  pane.scrollTop = 100;
  const touch = { ...mouse, pointerType: 'touch' };
  fireEvent.pointerDown(heads[0]!, touch);
  act(() => vi.advanceTimersByTime(100)); fireEvent.pointerUp(window, touch);
  act(() => vi.advanceTimersByTime(200)); expect(changes).not.toHaveBeenCalled();
  fireEvent.pointerDown(heads[0]!, touch);
  fireEvent.pointerMove(window, { ...touch, clientY: 80 });
  expect(pane.scrollTop).toBe(130);
  act(() => vi.advanceTimersByTime(300)); fireEvent.pointerUp(window, touch);
  expect(document.querySelector('.memo-section--dragging')).toBeNull(); expect(changes).not.toHaveBeenCalled();
  fireEvent.pointerDown(heads[0]!, touch);
  act(() => vi.advanceTimersByTime(MEMO_DRAG_HOLD_MS - 1));
  expect(document.querySelector('.memo-section--dragging')).toBeNull();
  act(() => vi.advanceTimersByTime(1)); expect(heads[0]!.closest('section')).toHaveClass('memo-section--dragging');
  fireEvent.pointerMove(window, { ...touch, clientY: 390 });
  act(() => vi.advanceTimersByTime(32)); expect(pane.scrollTop).toBeGreaterThan(130);
  fireEvent.pointerUp(window, { ...touch, clientY: 390 });
  expect(changes).toHaveBeenCalledTimes(1);
  expect(screen.getAllByRole('heading').map(head => head.textContent)).toEqual(['B', 'C', 'A']);
});
it('focuses at the end on open, splits Enter/Shift+Enter and preserves other DOM nodes', () => {
  surface('abc\nlast');
  expect(rows()[1]).toHaveFocus(); expect(rows()[1]!.selectionStart).toBe(4);
  const untouched = rows()[1]!; const first = rows()[0]!;
  first.focus(); first.setSelectionRange(1, 2);
  fireEvent.keyDown(first, { key: 'Enter', shiftKey: true });
  expect(texts()).toEqual(['a', 'c', 'last']);
  expect(rows()[1]).toHaveFocus(); expect(rows()[1]!.selectionStart).toBe(0);
  expect(rows()[2]).toBe(untouched);
  fireEvent.change(rows()[0]!, { target: { value: 'edited' } });
  expect(rows()[2]).toBe(untouched);
});
it('removes/joins with Backspace and never merges the first item into a heading', () => {
  surface('## A\nfirst\n\nnext\n## B\nlast');
  const empty = rows()[1]!; empty.focus(); empty.setSelectionRange(0, 0);
  fireEvent.keyDown(empty, { key: 'Backspace' });
  expect(texts()).toEqual(['first', 'next', 'last']); expect(rows()[0]).toHaveFocus(); expect(rows()[0]!.selectionStart).toBe(5);
  const next = rows()[1]!; next.focus(); next.setSelectionRange(0, 0); fireEvent.keyDown(next, { key: 'Backspace' });
  expect(texts()).toEqual(['firstnext', 'last']); expect(rows()[0]!.selectionStart).toBe(5);
  rows()[1]!.focus(); rows()[1]!.setSelectionRange(0, 0); fireEvent.keyDown(rows()[1]!, { key: 'Backspace' });
  expect(body()).toBe('## A\nfirstnext\n## B\nlast');
});
it('moves up/down only at text boundaries across visible items', () => {
  surface('one\ntwo');
  rows()[1]!.setSelectionRange(0, 0); fireEvent.keyDown(rows()[1]!, { key: 'ArrowUp' });
  expect(rows()[0]).toHaveFocus(); expect(rows()[0]!.selectionStart).toBe(3);
  fireEvent.keyDown(rows()[0]!, { key: 'ArrowDown' }); expect(rows()[1]).toHaveFocus(); expect(rows()[1]!.selectionStart).toBe(0);
  rows()[0]!.focus(); rows()[0]!.setSelectionRange(1, 1); fireEvent.keyDown(rows()[0]!, { key: 'ArrowDown' }); expect(rows()[0]).toHaveFocus();
});
it('toggles only its marker, collapses done by default and keeps done rows editable/toggleable', async () => {
  surface('## A\n* [X] done\n+ [ ] open');
  expect(texts()).toEqual(['open']); expect(rows()[0]).toHaveFocus();
  await userEvent.click(screen.getByRole('button', { name: '완료' }));
  expect(screen.queryByRole('textbox', { name: '메모 본문' })).not.toBeInTheDocument();
  expect(body()).toBe('## A\n* [X] done\n+ [x] open');
  await userEvent.click(screen.getByRole('button', { name: /완료 2/ }));
  expect(texts()).toEqual(['done', 'open']);
  expect(rows()[0]!.closest('.memo-item')).toHaveClass('is-done');
  fireEvent.change(rows()[0]!, { target: { value: 'updated' } });
  await userEvent.click(screen.getAllByRole('button', { name: '완료 취소' })[0]!);
  expect(texts()[0]).toBe('updated'); expect(body()).toBe('## A\n* [ ] updated\n+ [x] open');
});
it('filters chips with counts, hides the top part outside 전체, and resets when another note opens', async () => {
  const view = render(<MemoEditor noteId="one" body={'- [ ] top\n## A\n- [ ] a\n## B\n- [x] done\n- [ ] b'} onChange={vi.fn()}/>);
  const chips = within(screen.getByLabelText('메모 섹션'));
  await userEvent.click(chips.getByRole('button', { name: 'A 1' })); expect(texts()).toEqual(['a']);
  await userEvent.click(chips.getByRole('button', { name: '전체 3' })); expect(texts()).toEqual(['top', 'a', 'b']);
  await userEvent.click(chips.getByRole('button', { name: 'B 1' }));
  view.rerender(<MemoEditor noteId="two" body={'## A\nnew a\n## B\nnew b'} onChange={vi.fn()}/>);
  expect(texts()).toEqual(['new a', 'new b']); expect(rows()[1]).toHaveFocus();
});
it('moves to another section, exposes untitled top and makes a line a section', async () => {
  surface('top\n## A\na\n## B\nb');
  await userEvent.click(screen.getAllByRole('button', { name: '다른 섹션으로 옮기기' })[1]!);
  expect(await screen.findByRole('menuitem', { name: '제목 없음' })).toBeInTheDocument();
  await userEvent.click(screen.getByRole('menuitem', { name: 'B' }));
  expect(body()).toBe('top\n## A\n## B\nb\na');
  await userEvent.click(screen.getAllByRole('button', { name: '다른 섹션으로 옮기기' })[2]!);
  await userEvent.click(await screen.findByRole('menuitem', { name: '섹션으로 만들기' }));
  expect(body()).toBe('top\n## A\n## B\nb\n## a'); expect(screen.getByRole('heading', { name: 'a' })).toBeInTheDocument();
});
it('copies open todo items only and copies plain section lines including blank rows', async () => {
  const copyText = vi.fn(async () => {});
  surface('## A\n- [ ] open\n- [x] done', { copyText });
  await userEvent.click(screen.getByRole('button', { name: '복사' }));
  expect(copyText).toHaveBeenCalledWith('- open'); expect(screen.getByRole('status')).toHaveTextContent('복사됨');
  cleanup(); surface('## A\nplain\n\n**literal**', { copyText });
  await userEvent.click(screen.getByRole('button', { name: '복사' })); expect(copyText).toHaveBeenLastCalledWith('plain\n\n**literal**');
});
it('splits multiline paste, retaining task states and treating pasted headings as plain items', () => {
  surface('- [ ] ab\n- [ ] untouched');
  const untouched = rows()[1]!; rows()[0]!.setSelectionRange(1, 1);
  fireEvent.paste(rows()[0]!, { clipboardData: { getData: () => 'one\n* [X] two\n## title' } });
  expect(body()).toBe('- [ ] aone\n- [x] two\n- [ ] ## titleb\n- [ ] untouched');
  expect(texts()).toEqual(['aone', '## titleb', 'untouched']); expect(rows()[2]).toBe(untouched);
  expect(rows()[1]).toHaveFocus();
});
it('ignores composition keys and save echoes until composition commits without remounting', () => {
  const changes = vi.fn();
  const view = render(<MemoEditor noteId="one" body={'한\nother'} onChange={changes}/>);
  const area = rows()[0]!; area.focus();
  fireEvent.compositionStart(area); fireEvent.change(area, { target: { value: '한국' } });
  for (const key of ['Enter', 'Backspace', 'ArrowUp', 'ArrowDown']) fireEvent.keyDown(area, { key, isComposing: true });
  fireEvent.keyDown(area, { key: 'Enter', keyCode: 229 }); expect(changes).not.toHaveBeenCalled();
  view.rerender(<MemoEditor noteId="one" body={'한\nother updated'} onChange={changes}/>);
  expect(rows()[0]).toBe(area); expect(area.value).toBe('한국');
  fireEvent.compositionEnd(area); expect(changes).toHaveBeenCalledWith('한국\nother updated', false);
});
it('adds empty rows at section ends and focuses them; sizes using scrollHeight', async () => {
  const original = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'scrollHeight');
  Object.defineProperty(HTMLTextAreaElement.prototype, 'scrollHeight', { configurable: true, get: () => 72 });
  try {
    surface(''); expect(rows()[0]).toHaveFocus(); expect(rows()[0]!.style.height).toBe('72px');
    await userEvent.click(screen.getByRole('button', { name: '줄 추가' }));
    expect(rows()).toHaveLength(2); expect(rows()[1]).toHaveFocus(); expect(body()).toBe('\n');
  } finally { if (original) Object.defineProperty(HTMLTextAreaElement.prototype, 'scrollHeight', original); else delete (HTMLTextAreaElement.prototype as any).scrollHeight; }
});
it('renames, moves, unmakes and confirms deletion of sections', async () => {
  surface('## A\na\n## B\nb');
  await userEvent.click(screen.getByRole('button', { name: 'B 더보기' })); await userEvent.click(await screen.findByRole('menuitem', { name: '이름 바꾸기' }));
  const rename = screen.getByRole('textbox', { name: '섹션 이름' }); fireEvent.change(rename, { target: { value: 'renamed' } }); fireEvent.keyDown(rename, { key: 'Enter' });
  expect(body()).toBe('## A\na\n## renamed\nb');
  await userEvent.click(screen.getByRole('button', { name: 'renamed 더보기' })); await userEvent.click(await screen.findByRole('menuitem', { name: '위로' }));
  expect(body()).toBe('## renamed\nb\n## A\na');
  await userEvent.click(screen.getByRole('button', { name: 'A 더보기' })); await userEvent.click(await screen.findByRole('menuitem', { name: '섹션 풀기' }));
  expect(body()).toBe('## renamed\nb\nA\na');
  await userEvent.click(screen.getByRole('button', { name: 'renamed 더보기' })); await userEvent.click(await screen.findByRole('menuitem', { name: '섹션 삭제' }));
  expect(screen.getByRole('dialog', { name: '섹션 삭제' })).toBeInTheDocument(); expect(body()).not.toBe('');
  await userEvent.click(screen.getByRole('button', { name: '삭제' })); expect(body()).toBe('');
});
it('touch short taps preserve focus/selection and long press opens the same move menu', () => {
  surface('## A\na\n## B\nb', { touch: true });
  vi.useFakeTimers(); const area = rows()[0]!; area.focus(); area.setSelectionRange(0, 1);
  fireEvent.pointerDown(area, { button: 0, clientX: 10, clientY: 10 });
  act(() => vi.advanceTimersByTime(100)); fireEvent.pointerUp(area);
  expect(screen.queryByRole('menu')).not.toBeInTheDocument(); expect(area.selectionEnd).toBe(1);
  fireEvent.pointerDown(area, { button: 0, clientX: 10, clientY: 10 }); act(() => vi.advanceTimersByTime(MEMO_HOLD_MS));
  expect(screen.getByRole('menuitem', { name: 'B' })).toBeInTheDocument();
});
it('read-only notes use the same rows without mutation controls', () => {
  const change = surface('## A\n- [ ] open\n- [x] done', { readOnly: true });
  expect(rows()[0]).toHaveAttribute('readonly'); expect(screen.getByRole('button', { name: '완료' })).toBeDisabled();
  expect(screen.queryByRole('button', { name: '항목 추가' })).not.toBeInTheDocument(); expect(screen.queryByRole('button', { name: '복사' })).not.toBeInTheDocument();
  fireEvent.keyDown(rows()[0]!, { key: 'Enter' }); expect(change).not.toHaveBeenCalled();
});

it('keeps 500 existing row nodes through a line edit and a save acknowledgement', () => {
  const body = Array.from({ length: 500 }, (_, i) => `line ${i}`).join('\n');
  const view = render(<MemoEditor noteId="many" body={body} onChange={vi.fn()}/>);
  const before = rows();
  view.rerender(<MemoEditor noteId="many" body={body.replace('line 250\n', 'updated 250\n')} onChange={vi.fn()}/>);
  expect(rows()).toHaveLength(500);
  expect(rows()[250]).toBe(before[250]); expect(rows()[499]).toBe(before[499]); expect(rows()[499]).toHaveFocus();
}, 30000);
it('restores a rejected draft without replacing its textarea node', () => {
  render(<MemoEditor noteId="one" body="valid" onChange={() => false}/>);
  const area = rows()[0]!; fireEvent.change(area, { target: { value: 'rejected' } });
  expect(rows()[0]).toBe(area); expect(area.value).toBe('valid');
});

it('replaces fields between notes so an unfinished composition cannot enter the next note', () => {
  const changes = vi.fn();
  const view = render(<MemoEditor noteId="first" body="original" onChange={changes}/>);
  const area = rows()[0]!; fireEvent.compositionStart(area); fireEvent.change(area, { target: { value: '조합' } });
  view.rerender(<MemoEditor noteId="second" body="next" onChange={changes}/>);
  expect(rows()[0]).not.toBe(area); expect(rows()[0]).toHaveValue('next'); expect(rows()[0]).toHaveFocus();
  fireEvent.compositionEnd(area); expect(changes).not.toHaveBeenCalled();
});

it('opens an all-done note with focus in the editor so Esc and quick add remain reachable', () => {
  surface('## A\n- [x] done');
  expect(screen.getByRole('button', { name: '항목 추가' })).toHaveFocus();
});

it('keeps a composing section name mounted after blur and commits only after compositionend', async () => {
  const changes = surface('## A\nbody');
  await userEvent.click(screen.getByRole('button', { name: 'A 더보기' }));
  await userEvent.click(await screen.findByRole('menuitem', { name: '이름 바꾸기' }));
  const name = screen.getByRole('textbox', { name: '섹션 이름' });
  fireEvent.compositionStart(name);
  fireEvent.input(name, { target: { value: 'ㅎ' }, isComposing: true });
  fireEvent.keyDown(name, { key: 'Enter' });
  await userEvent.click(rows()[0]!);
  expect(screen.getByRole('textbox', { name: '섹션 이름' })).toBe(name);
  expect(changes).not.toHaveBeenCalled();
  fireEvent.input(name, { target: { value: '한' }, isComposing: true });
  fireEvent.compositionEnd(name, { data: '한' });
  expect(body()).toBe('## 한\nbody');
  expect(screen.queryByRole('textbox', { name: '섹션 이름' })).not.toBeInTheDocument();
});

it('lets the tablet back gesture close its own menu before the note', async () => {
  const backRef: { current: (() => boolean) | null } = { current: null };
  render(<MemoEditor noteId="n" body={'- [ ] 우유\n- [ ] 계란'} touch onChange={() => true} backRef={backRef} />);
  expect(backRef.current?.()).toBe(false);
  fireEvent.contextMenu(screen.getAllByRole('textbox')[0]!.closest('.memo-item')!);
  expect(await screen.findByRole('menuitem', { name: '섹션으로 만들기' })).toBeInTheDocument();
  let handled = false;
  act(() => { handled = backRef.current?.() ?? false; });
  expect(handled).toBe(true);
  await waitFor(() => expect(screen.queryByRole('menuitem', { name: '섹션으로 만들기' })).toBeNull());
  expect(backRef.current?.()).toBe(false);
});
