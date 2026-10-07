import {cleanup, fireEvent, render, screen, within} from '@testing-library/react';
import {afterEach, expect, it, vi} from 'vitest';
import {MoreButton, MoreSheet, type MoreOptions} from './MoreSheet';

afterEach(cleanup);
function options(overrides: Partial<MoreOptions> = {}): MoreOptions {
  return {reviewCount:3, unsortedCount:1200, unseen:2, trashCount:8, vaultPresent:true,
    onReview:vi.fn(), onUnsorted:vi.fn(), onExchange:vi.fn(), onVault:vi.fn(), onArtists:vi.fn(), onTrash:vi.fn(), onSettings:vi.fn(), ...overrides};
}
it('shows PC queue grouping and only tablet destinations', () => {
  render(<MoreSheet {...options()} onClose={vi.fn()}/>);
  expect(within(screen.getByRole('navigation',{name:'확인할 것'})).getAllByRole('button').map(button=>button.textContent)).toEqual(['유사 검토3','미분류1,200','전송2']);
  expect(within(screen.getByRole('navigation',{name:'이동'})).getAllByRole('button').map(button=>button.textContent)).toEqual(['비밀','작가','휴지통8','설정']);
  for (const label of ['통계','홈','에셋','컬렉션','카탈로그','메모']) expect(screen.queryByRole('button',{name:label})).toBeNull();
});
it('keeps empty queues reachable as destinations and omits an absent vault', () => {
  render(<MoreSheet {...options({reviewCount:0,unsortedCount:null,unseen:0,vaultPresent:false,trashCount:0})} onClose={vi.fn()}/>);
  expect(screen.queryByRole('navigation',{name:'확인할 것'})).toBeNull();
  expect(screen.queryByRole('button',{name:'비밀'})).toBeNull();
  expect(within(screen.getByRole('navigation',{name:'이동'})).getAllByRole('button').map(button=>button.textContent)).toEqual(['유사 검토','미분류','전송','작가','휴지통','설정']);
});
it.each([['유사 검토 3개','onReview'],['미분류 1,200개','onUnsorted'],['전송 2개','onExchange'],['비밀','onVault'],['작가','onArtists'],['휴지통 8개','onTrash'],['설정','onSettings']] as const)('closes More and runs %s', (label, action) => {
  const props=options(), close=vi.fn();
  render(<MoreSheet {...props} onClose={close}/>);
  fireEvent.click(screen.getByRole('button',{name:label}));
  expect(close).toHaveBeenCalledOnce(); expect(props[action]).toHaveBeenCalledOnce();
  expect(close.mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(props[action]).mock.invocationCallOrder[0]);
});
it('uses the accessible More label and a review-only capped corner count', () => {
  const open=vi.fn(), view=render(<MoreButton count={128} onOpen={open}/>);
  fireEvent.click(screen.getByRole('button',{name:'더보기'}));expect(open).toHaveBeenCalledOnce();
  expect(view.container.querySelector('.header-badge')?.textContent).toBe('99+');
  view.rerender(<MoreButton count={0} onOpen={open}/>);expect(view.container.querySelector('.header-badge')).toBeNull();
});
