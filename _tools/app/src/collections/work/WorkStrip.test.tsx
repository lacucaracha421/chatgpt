import {act, cleanup, fireEvent, render, screen, within} from '@testing-library/react';
import {afterEach, expect, it, vi} from 'vitest';
import {WorkStrip} from './WorkStage';

afterEach(cleanup);
const props = {av: false, mode: 'case', artworks: [{id: 'art'}], privacy: false, thumbnailUrl: (id: string) => `/thumb/${id}`, onPick: vi.fn()};
it('has only label-less artwork buttons, no case/inside buttons or separator, and toggles a selected tile back to the case', () => {
  const {container, rerender} = render(<WorkStrip {...props}/>);
  expect(screen.queryByRole('button', {name: '케이스'})).toBeNull();
  expect(screen.queryByRole('button', {name: '안쪽'})).toBeNull();
  expect(container.querySelector('.work-strip-separator')).toBeNull();
  const tile = screen.getByRole('button', {name: '아트워크 1'});
  expect(tile.textContent).toBe('');
  fireEvent.click(tile); expect(props.onPick).toHaveBeenLastCalledWith('art');
  rerender(<WorkStrip {...props} mode="art"/>);
  expect(tile).toHaveAttribute('aria-pressed', 'true');
  fireEvent.click(tile); expect(props.onPick).toHaveBeenLastCalledWith('case');
});
it('places the AV flat jacket first using its front thumbnail and the artwork selection style', () => {
  const {rerender} = render(<WorkStrip {...props} av mode="flat" frontThumbnailUrl="/front"/>);
  const buttons = within(screen.getByLabelText('작품 보기')).getAllByRole('button');
  expect(buttons[0]).toHaveAttribute('aria-label', '펼친 표지');
  expect(buttons[0]).toHaveClass('work-strip-art');
  expect(buttons[0]).toHaveAttribute('aria-pressed', 'true');
  expect(buttons[0].textContent).toBe('');
  expect(buttons[0].querySelector('img')).toHaveAttribute('src', '/front');
  fireEvent.click(buttons[0]); expect(props.onPick).toHaveBeenLastCalledWith('case');
  rerender(<WorkStrip {...props} av mode="flat" frontThumbnailUrl="/front" privacy/>);
  expect(buttons[0].querySelector('img')).toBeNull();
});
it('renders no strip without tiles, while an AV without additional artwork keeps its flat tile', () => {
  const {container, rerender} = render(<WorkStrip {...props} artworks={[]}/>);
  expect(container.firstChild).toBeNull();
  rerender(<WorkStrip {...props} artworks={[]} av/>);
  expect(screen.getByRole('button', {name: '펼친 표지'})).toBeTruthy();
});


it('ignores cancelled thumbnail decodes when a pending work changes away and back to the same source', async () => {
  const onReady = vi.fn();
  const {container, rerender} = render(<WorkStrip {...props} thumbnailUrl={() => '/a'} onReady={onReady}/>);
  const image = container.querySelector<HTMLImageElement>('img')!;
  const pending: (() => void)[] = [];
  Object.defineProperty(image, 'decode', {value: () => new Promise<void>(resolve => pending.push(resolve))});
  fireEvent.load(image);
  rerender(<WorkStrip {...props} thumbnailUrl={() => '/b'} onReady={onReady}/>);
  fireEvent.load(image);
  rerender(<WorkStrip {...props} thumbnailUrl={() => '/a'} onReady={onReady}/>);
  await act(async () => {pending[0](); pending[1]();});
  expect(onReady).not.toHaveBeenCalled();
  fireEvent.load(image);
  await act(async () => pending[2]());
  expect(onReady).toHaveBeenCalled();
});

it('settles failed strip images so the work can switch to its available faces', async () => {
  const onReady = vi.fn();
  const {container} = render(<WorkStrip {...props} av frontThumbnailUrl="/front" onReady={onReady}/>);
  await act(async () => fireEvent.load(container.querySelector('img[src="/front"]')!));
  expect(onReady).not.toHaveBeenCalled();
  await act(async () => fireEvent.error(container.querySelector('img[src="/thumb/art"]')!));
  expect(onReady).toHaveBeenCalled();
});

it('accepts the pending decode of an unchanged thumbnail when more artwork arrives', async () => {
  const onReady = vi.fn();
  const {container, rerender} = render(<WorkStrip {...props} onReady={onReady}/>);
  const first = container.querySelector<HTMLImageElement>('img')!;
  let decoded!: () => void;
  Object.defineProperty(first, 'decode', {value: () => new Promise<void>(resolve => {decoded = resolve;})});
  fireEvent.load(first);
  rerender(<WorkStrip {...props} artworks={[{id: 'art'}, {id: 'new'}]} onReady={onReady}/>);
  await act(async () => fireEvent.load(container.querySelector('img[src="/thumb/new"]')!));
  expect(onReady).not.toHaveBeenCalled();
  await act(async () => decoded());
  expect(onReady).toHaveBeenCalled();
});
