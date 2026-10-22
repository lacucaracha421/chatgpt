import {act, cleanup, fireEvent, render, screen, within} from '@testing-library/react';
import {afterEach, expect, it, vi} from 'vitest';
import {MoreButton, MoreSheet, type MoreOptions} from './MoreSheet';
import {beginScreenTiming, cancelScreenTiming} from './perf';
import {resetPerfEnabledForTests} from './perfEnabled';

afterEach(cleanup);
it('reserves the trash count slot and shows only the fresh complete read on each opening',async()=>{
  let finish!:(count:number|null)=>void;
  const readTrashCount=vi.fn((_signal:AbortSignal)=>new Promise<number|null>(resolve=>{finish=resolve;}));
  const props=options({trashCount:8,readTrashCount});
  const view=render(<MoreSheet {...props} onClose={vi.fn()}/>);
  const row=screen.getByRole('button',{name:'휴지통'}),slot=row.querySelector('.more-panel__count--trash');
  expect(slot?.textContent).toBe('');expect(row.textContent).toBe('휴지통');
  await act(async()=>finish(12));
  expect(screen.getByRole('button',{name:'휴지통 12개'})).toBe(row);
  expect(row.querySelector('.more-panel__count--trash')).toBe(slot);
  view.unmount();render(<MoreSheet {...props} onClose={vi.fn()}/>);
  expect(screen.getByRole('button',{name:'휴지통'}).textContent).toBe('휴지통');
  await act(async()=>finish(null));expect(screen.getByRole('button',{name:'휴지통'}).textContent).toBe('휴지통');
  expect(readTrashCount).toHaveBeenCalledTimes(2);
  expect(readTrashCount.mock.calls[0]![0].aborted).toBe(true);
});
it('puts the screen rows before the existing More groups and runs their actions',()=>{
 const run=vi.fn(),close=vi.fn();
 render(<MoreSheet {...options()} screenTitle="폴더" screenEntries={[{id:'folder',group:'action',label:'폴더 관리',icon:<span/>,run}]} onClose={close}/>);
 expect(screen.getByRole('dialog',{name:'폴더'})).toBeTruthy();
 expect(screen.getAllByRole('navigation').map(nav=>nav.getAttribute('aria-label'))).toEqual(['폴더','확인할 것','이동']);
 fireEvent.click(screen.getByRole('button',{name:'폴더 관리'}));expect(run).toHaveBeenCalledOnce();expect(close).toHaveBeenCalledOnce();
});
function options(overrides: Partial<MoreOptions> = {}): MoreOptions {
  return {reviewCount:3, unsortedCount:1200, unseen:2, trashCount:8, vaultPresent:true,
    onReview:vi.fn(), onUnsorted:vi.fn(), onExchange:vi.fn(), onVault:vi.fn(), onArtists:vi.fn(), onTrash:vi.fn(), onSettings:vi.fn(), ...overrides};
}
it('shows PC queue grouping and only tablet destinations', () => {
  render(<MoreSheet {...options()} onClose={vi.fn()}/>);
  expect(within(screen.getByRole('navigation',{name:'확인할 것'})).getAllByRole('button').map(button=>button.textContent)).toEqual(['유사 이미지 검토3','미분류1,200','전송2']);
  expect(within(screen.getByRole('navigation',{name:'이동'})).getAllByRole('button').map(button=>button.textContent)).toEqual(['비밀','작가','휴지통8','설정']);
  for (const label of ['통계','홈','에셋','컬렉션','카탈로그','메모']) expect(screen.queryByRole('button',{name:label})).toBeNull();
});
it('keeps empty queues reachable as destinations and omits an absent vault', () => {
  render(<MoreSheet {...options({reviewCount:0,unsortedCount:null,unseen:0,vaultPresent:false,trashCount:0})} onClose={vi.fn()}/>);
  expect(screen.queryByRole('navigation',{name:'확인할 것'})).toBeNull();
  expect(screen.queryByRole('button',{name:'비밀'})).toBeNull();
  expect(within(screen.getByRole('navigation',{name:'이동'})).getAllByRole('button').map(button=>button.textContent)).toEqual(['유사 이미지 검토','미분류','전송','작가','휴지통','설정']);
});
it.each([['유사 이미지 검토 3개','onReview'],['미분류 1,200개','onUnsorted'],['전송 2개','onExchange'],['비밀','onVault'],['작가','onArtists'],['휴지통 8개','onTrash'],['설정','onSettings']] as const)('closes More and runs %s', (label, action) => {
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
it('reports More ready once its portal content is shown, not canceled', () => {
  resetPerfEnabledForTests(); vi.useFakeTimers();
  const request = vi.fn(); window.LakomicsNative = {request, cancel: vi.fn(), perfEnabled: () => true};
  try {
    beginScreenTiming('more', 'open');
    render(<MoreSheet {...options()} onClose={vi.fn()}/>);
    vi.advanceTimersByTime(32);
    const lines = request.mock.calls.map(call => JSON.parse(call[2]));
    expect(lines).toEqual([expect.objectContaining({event: 'screen', screen: 'more', trigger: 'open', status: 'ok'})]);
    expect(lines[0].readyMs).toBeGreaterThanOrEqual(0);
  } finally {
    cancelScreenTiming(); vi.clearAllTimers(); vi.useRealTimers(); delete window.LakomicsNative; resetPerfEnabledForTests();
  }
});
it('lists 링크 보관 with the destinations when the app can open it, and runs it after closing More', () => {
  const onLinks=vi.fn(), close=vi.fn();
  render(<MoreSheet {...options({onLinks})} onClose={close}/>);
  const go=within(screen.getByRole('navigation',{name:'이동'}));
  expect(go.getAllByRole('button').map(button=>button.textContent)).toContain('링크 보관');
  fireEvent.click(go.getByRole('button',{name:'링크 보관'}));
  expect(close).toHaveBeenCalledOnce(); expect(onLinks).toHaveBeenCalledOnce();
});
