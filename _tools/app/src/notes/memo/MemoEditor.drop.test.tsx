import { useState } from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { NativeFileDropEvent } from '../../ingestion/useFileDrop';
import { noteLimitProblem } from '../model';
import { MemoEditor } from './MemoEditor';

const native = vi.hoisted(() => ({ subscribe: vi.fn(), stop: vi.fn() }));
vi.mock('../../ingestion/useFileDrop', () => ({ subscribeToTauriDrops: native.subscribe }));
let handler: (event: NativeFileDropEvent) => void;
beforeEach(() => {
  native.subscribe.mockReset(); native.stop.mockReset();
  native.subscribe.mockImplementation(async (callback: typeof handler) => { handler = callback; return native.stop; });
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });
const rect = (top: number, bottom: number) => ({ x: 0, y: top, left: 0, right: 500, top, bottom, width: 500, height: bottom - top, toJSON: () => ({}) }) as DOMRect;
async function surface(initial = '## A\nalpha\n## B\nbeta', options: { readOnly?: boolean; touch?: boolean } = {}) {
  const changes = vi.fn();
  function Harness() {
    const [body, setBody] = useState(initial);
    const [problem, setProblem] = useState<string | null>(null);
    return <><output data-testid="body">{body}</output>{problem && <p role="alert">{problem}</p>}
      <MemoEditor noteId="one" body={body} {...options} onChange={(next, structural) => {
        const error = noteLimitProblem({ type: 'text', title: '', body: next });
        setProblem(error); if (error) return false;
        changes(next, structural); setBody(next); return true;
      }}/></>;
  }
  const result = render(<Harness/>);
  const editor = document.querySelector<HTMLElement>('.memo-editor')!;
  vi.spyOn(editor, 'getBoundingClientRect').mockReturnValue(rect(0, 400));
  [...editor.querySelectorAll('.memo-section')].forEach((section, index) => vi.spyOn(section, 'getBoundingClientRect').mockReturnValue(rect(50 + index * 100, 150 + index * 100)));
  await act(async () => {});
  return { ...result, changes, editor };
}
const areas = () => screen.getAllByRole('textbox', { name: '메모 본문' }) as HTMLTextAreaElement[];
const value = () => screen.getByTestId('body').textContent;
function drop(paths: string[], y = 75, x = 20) { act(() => handler({ type: 'drop', paths, position: { x, y } })); }
const screenshot = 'C:\\ShareX\\Screenshots\\shot.png';
const video = 'C:\\Users\\laku\\Videos\\clip.mp4';
it.each([[screenshot], [screenshot, video]])('inserts %j at the focused caret through normal edits', async (...paths: string[]) => {
  const { changes } = await surface();
  const area = areas()[0]!; area.focus(); area.setSelectionRange(2, 2);
  drop(paths);
  expect(value()).toBe('## A\nal' + paths.join('\n') + 'pha\n## B\nbeta');
  expect(changes).toHaveBeenCalledTimes(1);
  expect(changes.mock.calls[0]![1]).toBe(true);
  expect(area.selectionStart).toBe(2 + paths.join('\n').length);
  expect(native.subscribe).toHaveBeenCalledTimes(1);
});
it('replaces the selected text and subsequent typing keeps the inserted paths', async () => {
  await surface(); const area = areas()[0]!; area.focus(); area.setSelectionRange(1, 4);
  drop([screenshot]);
  expect(area.value).toBe('a' + screenshot + 'a');
  fireEvent.change(area, { target: { value: area.value + ' typed' } });
  expect(value()).toContain(screenshot + 'a typed');
});
it('uses the section under the drop even when another section has focus', async () => {
  await surface(); areas()[0]!.focus(); areas()[0]!.setSelectionRange(1, 1);
  drop([screenshot, video], 175);
  expect(value()).toBe('## A\nalpha\n## B\nbeta\n' + screenshot + '\n' + video);
});
it('appends under the drop point without focus, or to the last section in editor whitespace', async () => {
  await surface(); areas()[1]!.blur(); drop([screenshot]);
  expect(value()).toBe('## A\nalpha\n' + screenshot + '\n## B\nbeta');
  areas()[0]!.blur(); drop([video], 350);
  expect(value()).toBe('## A\nalpha\n' + screenshot + '\n## B\nbeta\n' + video);
});
it('rejects a UTF-8 body beyond 128 KiB with the existing limit message', async () => {
  const initial = '가'.repeat(43690);
  const { changes } = await surface(initial);
  const area = areas()[0]!; area.focus(); area.setSelectionRange(initial.length, initial.length);
  drop([screenshot, video]);
  expect(value()).toBe(initial); expect(area.value).toBe(initial);
  expect(changes).not.toHaveBeenCalled(); expect(screen.getByRole('alert')).toHaveTextContent('128 KiB');
});
it('accepts the exact 128 KiB boundary', async () => {
  const initial = 'a'.repeat(128 * 1024 - screenshot.length);
  await surface(initial); drop([screenshot]);
  expect(value()).toHaveLength(128 * 1024);
});
it('shows a light affordance only over the editor and clears it on leave, cancel and drop', async () => {
  const { editor } = await surface();
  act(() => handler({ type: 'enter', paths: [screenshot], position: { x: 20, y: 75 } }));
  expect(editor).toHaveClass('memo-editor--file-over'); expect(screen.getByText('파일 경로 넣기')).toBeInTheDocument();
  act(() => handler({ type: 'over', position: { x: 600, y: 75 } })); expect(editor).not.toHaveClass('memo-editor--file-over');
  for (const type of ['leave', 'cancel'] as const) {
    act(() => handler({ type: 'over', position: { x: 20, y: 75 } }));
    act(() => handler({ type })); expect(editor).not.toHaveClass('memo-editor--file-over');
  }
  drop([screenshot]); expect(editor).not.toHaveClass('memo-editor--file-over');
});
it('ignores drops outside or on a hidden editor', async () => {
  const { editor, changes } = await surface(); drop([screenshot], 75, 600);
  editor.hidden = true; drop([screenshot]); expect(changes).not.toHaveBeenCalled();
});
it('converts native physical positions at Windows display scaling', async () => {
  await surface(); vi.spyOn(window, 'devicePixelRatio', 'get').mockReturnValue(2);
  areas()[0]!.focus(); areas()[0]!.setSelectionRange(0, 0); drop([screenshot], 150, 40);
  expect(value()).toBe('## A\n' + screenshot + 'alpha\n## B\nbeta');
});
it('preserves CRLF note bodies while inserting multiple paths', async () => {
  await surface('## A\r\nalpha\r\n## B\r\nbeta'); areas()[0]!.focus(); areas()[0]!.setSelectionRange(2, 2);
  drop([screenshot, video]); expect(value()).toBe('## A\r\nal' + screenshot + '\r\n' + video + 'pha\r\n## B\r\nbeta');
});
it('inserts one path per task line in todo mode', async () => {
  await surface('## A\n- [ ] alpha\n## B\n- [ ] beta'); areas()[0]!.focus(); areas()[0]!.setSelectionRange(2, 2);
  drop([screenshot, video]); expect(value()).toBe('## A\n- [ ] al' + screenshot + '\n- [ ] ' + video + 'pha\n## B\n- [ ] beta');
});
it('unsubscribes on unmount and ignores late events', async () => {
  const { unmount, changes } = await surface(); unmount();
  expect(native.stop).toHaveBeenCalledTimes(1); drop([screenshot]); expect(changes).not.toHaveBeenCalled();
});
it('removes a subscription that resolves after unmount', async () => {
  let resolve!: (stop: () => void) => void;
  native.subscribe.mockImplementation(callback => { handler = callback; return new Promise<() => void>(done => { resolve = done; }); });
  const { unmount } = await surface(); unmount();
  await act(async () => resolve(native.stop)); expect(native.stop).toHaveBeenCalledTimes(1);
});
it.each([{ readOnly: true }, { touch: true }])('does not subscribe for %j', async options => {
  await surface(undefined, options); expect(native.subscribe).not.toHaveBeenCalled();
});
