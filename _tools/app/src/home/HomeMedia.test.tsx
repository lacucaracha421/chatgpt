import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import type { HomeMedia, LibraryGateway } from '../library/types';
import { HomeDay } from './HomeRevisit';
import { useHomeMedia } from './useHomeMedia';

afterEach(cleanup);
const media = { playing: [], dailyAsset: { id: 'favorite', collectedAt: '2023-07-18T12:00:00Z', favorite: true } } as HomeMedia;

function Fixture({ gateway, active = true, date = '2026-10-04', privacy = false, quiet = true, open = vi.fn() }: {
  gateway: LibraryGateway; active?: boolean; date?: string; privacy?: boolean; quiet?: boolean; open?: (id: string) => void;
}) {
  const read = useHomeMedia(gateway, date, active, 0);
  return <HomeDay data={read.data} failed={read.failed} quiet={quiet} privacyMode={privacy} onOpenAsset={open} />;
}

it('opens the daily favorite, masks both images in privacy, and hides it on a busy day', async () => {
  const gateway = { getHomeMedia: vi.fn().mockResolvedValue(media), getRevisitSlate: vi.fn().mockResolvedValue({ bundles: [] }) } as unknown as LibraryGateway;
  const open = vi.fn();
  const view = render(<Fixture gateway={gateway} open={open} />);
  fireEvent.click(await screen.findByRole('button', { name: '열기' }));
  expect(open).toHaveBeenCalledWith('favorite');
  expect(screen.getByText('2023.7.18에 저장')).toBeTruthy();
  expect(view.container.querySelectorAll('img')).toHaveLength(2);
  view.rerender(<Fixture gateway={gateway} privacy />);
  expect(view.container.querySelectorAll('img')).toHaveLength(0);
  view.rerender(<Fixture gateway={gateway} quiet={false} />);
  expect(screen.queryByText('오늘의 한 장')).toBeNull();
});

it('retains the previous day while refreshing, including failed re-entry reads', async () => {
  const read = vi.fn().mockResolvedValue(media);
  const gateway = { getHomeMedia: read, getRevisitSlate: vi.fn().mockResolvedValue({ bundles: [] }) } as unknown as LibraryGateway;
  const view = render(<Fixture gateway={gateway} />);
  await screen.findByRole('button', { name: '열기' });
  let finish!: (value: HomeMedia) => void;
  read.mockReturnValueOnce(new Promise<HomeMedia>(resolve => { finish = resolve; }));
  view.rerender(<Fixture gateway={gateway} date="2026-10-05" />);
  expect(screen.getByText('2023.7.18에 저장')).toBeTruthy();
  await act(async () => finish({ ...media, dailyAsset: { ...media.dailyAsset!, collectedAt: '2024-01-02T12:00:00Z' } }));
  await screen.findByText('2024.1.2에 저장');
  view.rerender(<Fixture gateway={gateway} date="2026-10-05" active={false} />);
  read.mockRejectedValueOnce(new Error('offline'));
  view.rerender(<Fixture gateway={gateway} date="2026-10-05" />);
  await waitFor(() => expect(screen.getByRole('status').textContent).toContain('확인할 수 없습니다'));
  expect(screen.getByText('2024.1.2에 저장')).toBeTruthy();
});

it('prefers the anniversary mosaic and keeps its five tiles and overflow count', async () => {
  const gateway = { getHomeMedia: vi.fn().mockResolvedValue(media), getRevisitSlate: vi.fn().mockResolvedValue({ bundles: [{ kind: 'date', assetIds: ['1', '2', '3', '4', '5', '6', '7', '8'] }] }) } as unknown as LibraryGateway;
  render(<Fixture gateway={gateway} />);
  expect(await screen.findByText('+3')).toBeTruthy();
  expect(screen.getAllByRole('button', { name: '1년 전 오늘 이미지 열기' })).toHaveLength(5);
  expect(screen.queryByText('오늘의 한 장')).toBeNull();
});
