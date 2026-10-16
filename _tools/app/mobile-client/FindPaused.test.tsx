import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { FindSheet } from './FindSheet';

const mocks = vi.hoisted(() => ({ api: vi.fn() }));
vi.mock('./transport', async original => ({ ...await original<typeof import('./transport')>(), api: mocks.api }));
afterEach(() => { cleanup(); vi.useRealTimers(); });

it('shows name results without scene requests or caption waiting states while paused', async () => {
  vi.useFakeTimers();
  const run = vi.fn(), onDescription = vi.fn();
  render(<FindSheet open context={{ tab: 'assets' }} onClose={vi.fn()} endpoint="paused" privacy={false}
    entries={[{ id: 'folder', group: 'place', label: '눈 내리는 폴더', run }]}
    onDescription={onDescription} />);
  const input = screen.getByRole('combobox');
  fireEvent.change(input, { target: { value: '눈 내리는' } });
  await act(async () => { await vi.advanceTimersByTimeAsync(500); });
  expect(screen.queryByText(/장면 찾기|아직 준비 중/)).toBeNull();
  expect(screen.getByRole('option').textContent).toContain('눈 내리는 폴더');
  fireEvent.keyDown(input, { key: 'Enter' });
  expect(run).toHaveBeenCalledOnce();
  expect(onDescription).not.toHaveBeenCalled();
  expect(mocks.api).not.toHaveBeenCalled();
});
