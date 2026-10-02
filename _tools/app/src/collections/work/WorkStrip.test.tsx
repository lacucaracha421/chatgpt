import {cleanup, fireEvent, render, screen, within} from '@testing-library/react';
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
