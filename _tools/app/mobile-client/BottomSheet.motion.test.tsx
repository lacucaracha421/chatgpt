import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { BottomSheet } from './BottomSheet';
import { SelectionBar } from '../src/assets/SelectionBar';

afterEach(() => {
  cleanup();
  document.querySelectorAll('[data-motion-ghost]').forEach(node => node.remove());
  vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals();
});

it.each([false, true])('retains the closing sheet and scrim after the conditional owner leaves (reduced=%s)', reduced => {
  vi.useFakeTimers();
  vi.stubGlobal('matchMedia', vi.fn(() => ({matches:reduced})));
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({width:300,height:400} as DOMRect);
  const { unmount } = render(<BottomSheet title="Sort" onClose={vi.fn()}><button>Recent</button></BottomSheet>);
  const sheet = screen.getByRole('dialog');
  expect(sheet.dataset.motion).toBe('dialog');
  act(() => vi.advanceTimersByTime(20));
  unmount();
  const ghosts = [...document.querySelectorAll<HTMLElement>('[data-motion-ghost]')];
  expect(ghosts.map(node => node.dataset.motion).sort()).toEqual(['dialog','scrim']);
  expect(ghosts.every(node => node.inert && node.getAttribute('aria-hidden') === 'true')).toBe(true);
  expect(screen.queryByRole('dialog')).toBeNull();
  act(() => vi.advanceTimersByTime(20));
  expect(ghosts.every(node => node.dataset.state === 'closed')).toBe(true);
  act(() => vi.advanceTimersByTime(300));
  expect(ghosts.every(node => !node.isConnected)).toBe(true);
});

it('uses the same retained selection bar on tablet without painting a zero count', () => {
  vi.useFakeTimers();
  const { rerender } = render(<SelectionBar selectedCount={2} batchPending={false} onClearSelection={vi.fn()}/>);
  const bar = screen.getByRole('toolbar');
  vi.spyOn(bar, 'getBoundingClientRect').mockReturnValue({width:300} as DOMRect);
  act(() => vi.advanceTimersToNextFrame());
  rerender(<SelectionBar selectedCount={0} batchPending={false} onClearSelection={vi.fn()}/>);
  const ghost = document.querySelector<HTMLElement>('[data-motion="selection"][data-motion-ghost]')!;
  expect(ghost.textContent).toContain('2개 선택');
  act(() => vi.advanceTimersToNextFrame());
  expect(ghost.dataset.state).toBe('closed');
  act(() => vi.advanceTimersByTime(180));
  expect(ghost.isConnected).toBe(false);
});

it('travels the entire sheet height and shares the opacity-only reduced-motion rule', () => {
  const sheet = readFileSync('mobile-client/library.css', 'utf8');
  const motion = readFileSync('src/styles/surface-motion.css', 'utf8');
  expect(sheet).toContain('--surface-y: 100%');
  expect(motion).toContain('translate: none !important; scale: none !important; transition: opacity var(--motion-micro)');
});
