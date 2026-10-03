import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { StrictMode, useEffect, useRef } from 'react';
import { AreaSwitch, MotionScope } from './AreaSwitch';
import { useFirstAppearance } from './useFirstAppearance';
import { EASE_SHEET, EASE_SPRING, SPRING_FALLBACK, springEasing } from './curves';
import { readFileSync } from 'node:fs';

let reduce = false;
let change: (() => void) | undefined;
const animate = vi.fn();
beforeEach(() => {
  vi.useFakeTimers(); reduce = false;
  vi.stubGlobal('CSS', {supports: () => false});
  vi.stubGlobal('matchMedia', () => ({get matches() {return reduce;}, addEventListener: (_: string, listener: () => void) => {change = listener;}, removeEventListener: vi.fn()}));
  animate.mockImplementation(() => ({cancel: vi.fn(), onfinish: null}));
  Object.defineProperty(HTMLElement.prototype, 'animate', {configurable: true, value: animate});
});
afterEach(() => { cleanup(); delete (HTMLElement.prototype as Partial<HTMLElement>).animate; vi.useRealTimers(); vi.unstubAllGlobals(); vi.clearAllMocks(); change = undefined; });
const tick = async (ms = 32) => { await act(async () => { await vi.advanceTimersByTimeAsync(ms); }); };

it('shares the exact prototype spring samples with CSS and falls back without linear()', () => {
  const css = readFileSync('src/styles/tokens.css', 'utf8');
  expect(css).toContain(`--ease-spring: ${EASE_SPRING}`);
  expect(css).toContain(`--ease-sheet: ${EASE_SHEET}`);
  expect(css).toContain('@supports (transition-timing-function: linear(0, 1))');
  vi.stubGlobal('CSS', {supports: () => false}); expect(springEasing()).toBe(SPRING_FALLBACK);
  vi.stubGlobal('CSS', {supports: () => true}); expect(springEasing()).toBe(EASE_SPRING);
});

it('keeps the exact old DOM inert while waiting, overlaps when ready, removes it after 160ms', async () => {
  const tree = (loading: boolean) => <AreaSwitch activeKey="assets" views={{assets: loading ? <span className="asset-browser__skeleton">waiting</span> : <button>new</button>}} />;
  const view = render(<AreaSwitch activeKey="home" views={{home: <button>old</button>}} />);
  const old = screen.getByText('old');
  view.rerender(tree(true)); await tick();
  expect(old.isConnected).toBe(true); expect(old.closest('[inert]')).not.toBeNull();
  expect(old.closest<HTMLElement>('[data-motion-view]')?.style.visibility).toBe('');
  expect(screen.getByText('waiting').closest<HTMLElement>('[data-motion-view]')?.style.visibility).toBe('hidden');
  expect(animate).not.toHaveBeenCalled();
  view.rerender(tree(false)); await tick();
  expect(old.isConnected).toBe(true); expect(screen.getByRole('button', {name: 'new'})).toBeTruthy();
  expect(animate.mock.calls.map(call => call[1])).toEqual([{duration: 160, easing: 'cubic-bezier(0.2, 0, 0, 1)'}, {duration: 380, easing: EASE_SHEET}]);
  expect(animate.mock.calls[1][0]).toEqual([{top: '12px', bottom: '-12px'}, {top: '0px', bottom: '0px'}]);
  await tick(160); expect(old.isConnected).toBe(false);
  expect(screen.getByRole('button', {name: 'new'})).toBeTruthy();
});

it('switches instantly once ready under reduced motion, preserving old content during its load', async () => {
  reduce = true;
  const view = render(<AreaSwitch activeKey="home" views={{home: <b>old</b>}} />);
  view.rerender(<AreaSwitch activeKey="assets" views={{assets: <span className="library-content__deferred"/>}} />); await tick();
  expect(screen.getByText('old')).toBeTruthy();
  view.rerender(<AreaSwitch activeKey="assets" views={{assets: <b>new</b>}} />); await tick();
  expect(screen.queryByText('old')).toBeNull(); expect(animate).not.toHaveBeenCalled();
});

it('cancels superseded transitions and never shows the abandoned pending view', async () => {
  const view = render(<AreaSwitch activeKey="home" views={{home: <b>old</b>}} />);
  view.rerender(<AreaSwitch activeKey="assets" views={{assets: <b className="asset-browser__skeleton">pending</b>}} />); await tick();
  view.rerender(<AreaSwitch activeKey="notes" views={{notes: <b>notes</b>}} />); await tick();
  expect(screen.queryByText('pending')).toBeNull(); expect(screen.getByText('old')).toBeTruthy();
  await tick(160); expect(screen.queryByText('old')).toBeNull(); expect(screen.getByText('notes')).toBeTruthy();
});

it('preserves retained surface DOM and mounts while hiding it on departure and showing it on revisit', async () => {
  const mounts = vi.fn();
  function Notes({active}: {active: boolean}) {useEffect(() => {mounts();}, []); return <button style={{display: active ? undefined : 'none'}}>notes</button>;}
  const tree = (activeKey: string) => <AreaSwitch activeKey={activeKey} retained={['notes']} views={{notes: <Notes active={activeKey === 'notes'}/>, home: <b>home</b>}} />;
  const view = render(tree('notes')); const notes = screen.getByText('notes');
  view.rerender(tree('home')); await tick(); expect(notes.style.display).toBe('');
  await tick(160); expect(notes.isConnected).toBe(true); expect(notes.style.display).toBe('none');
  view.rerender(tree('notes')); await tick(); await tick(160);
  expect(screen.getByRole('button', {name: 'notes'})).toBe(notes); expect(mounts).toHaveBeenCalledTimes(1);
});

function Tiles({count}: {count: number}) {
  const host = useRef<HTMLDivElement>(null); useFirstAppearance(host, count);
  return <div ref={host}>{Array.from({length: count}, (_, i) => <b data-asset-id={i} key={i}>tile {i}</b>)}</div>;
}
it('waits for the first loaded tiles, caps stagger at 18, and skips rerenders, paging and remount revisits', () => {
  const tree = (count: number, mount = true) => <MotionScope>{mount && <Tiles count={count}/>}</MotionScope>;
  const view = render(tree(0)); expect(animate).not.toHaveBeenCalled();
  view.rerender(tree(22)); expect(animate).toHaveBeenCalledTimes(22);
  expect(animate.mock.calls[0][0]).toEqual([{opacity: 0, transform: 'translateY(8px) scale(.98)'}, {opacity: 1, transform: 'none'}]);
  expect(animate.mock.calls[21][1]).toEqual({duration: 560, delay: 432, easing: SPRING_FALLBACK, fill: 'backwards'});
  view.rerender(tree(24)); view.rerender(tree(4)); view.rerender(tree(0, false)); view.rerender(tree(22));
  expect(animate).toHaveBeenCalledTimes(22);
});
it('consumes the first appearance without animations under reduced motion', () => {
  reduce = true; const view = render(<MotionScope><Tiles count={2}/></MotionScope>);
  reduce = false; view.rerender(<MotionScope><Tiles count={4}/></MotionScope>);
  expect(animate).not.toHaveBeenCalled();
});
it('keeps the first appearance running through the desktop StrictMode effect replay', () => {
  const view = render(<StrictMode><MotionScope><Tiles count={2}/></MotionScope></StrictMode>);
  expect(animate).toHaveBeenCalledTimes(2);
  for (const result of animate.mock.results) expect(result.value.cancel).not.toHaveBeenCalled();
  view.unmount();
  for (const result of animate.mock.results) expect(result.value.cancel).toHaveBeenCalledOnce();
});
it('commits explicit readiness changes even when the incoming DOM does not change', async () => {
  const view = render(<AreaSwitch activeKey="home" views={{home: <b>old</b>}}/>);
  view.rerender(<AreaSwitch activeKey="assets" views={{assets: <b>empty</b>}} ready={() => false}/>);
  expect(screen.getByText('old').isConnected).toBe(true); expect(animate).not.toHaveBeenCalled();
  view.rerender(<AreaSwitch activeKey="assets" views={{assets: <b>empty</b>}} ready={() => true}/>);
  expect(animate).not.toHaveBeenCalled();
  await tick();
  expect(animate).toHaveBeenCalledTimes(2);
  await tick(160); expect(screen.queryByText('old')).toBeNull();
});

it('keeps the old view visible for a rendering frame after readiness before starting motion', async () => {
  const view = render(<AreaSwitch activeKey="home" views={{home: <b>old</b>}} />);
  const tree = (ready: boolean) => <AreaSwitch activeKey="catalog" views={{catalog: <button>catalog</button>}} ready={() => ready}/>;
  view.rerender(tree(false)); await tick(0);
  view.rerender(tree(true));
  expect(animate).not.toHaveBeenCalled();
  await tick(16); expect(animate).not.toHaveBeenCalled();
  expect(screen.getByText('old').closest<HTMLElement>('[data-motion-view]')?.style.visibility).toBe('');
  expect(screen.getByText('catalog').closest<HTMLElement>('[data-motion-view]')?.style.visibility).toBe('hidden');
  await tick(16); expect(animate).toHaveBeenCalledTimes(2);
  expect(screen.getByRole('button', {name: 'catalog'})).toBeTruthy();
});

it('rechecks readiness during the frame wait and cancels a superseded ready view', async () => {
  const view = render(<AreaSwitch activeKey="home" views={{home: <b>old</b>}} />);
  const tree = (ready: boolean) => <AreaSwitch activeKey="catalog" views={{catalog: <b>catalog</b>}} ready={() => ready}/>;
  view.rerender(tree(true)); await tick(16);
  view.rerender(tree(false)); await tick(); expect(animate).not.toHaveBeenCalled();
  view.rerender(tree(true)); await tick(16);
  view.rerender(<AreaSwitch activeKey="notes" views={{notes: <b>notes</b>}}/>);
  await tick(16); expect(animate).not.toHaveBeenCalled();
  await tick(16); expect(animate).toHaveBeenCalledTimes(2);
  expect(animate.mock.contexts.every(host => (host as HTMLElement).dataset.motionView === 'notes')).toBe(true);
});

it('keeps the 1s cap even when rendering frames are suspended', async () => {
  vi.stubGlobal('requestAnimationFrame', vi.fn(() => 99));
  vi.stubGlobal('cancelAnimationFrame', vi.fn());
  const view = render(<AreaSwitch activeKey="home" views={{home: <b>old</b>}}/>);
  view.rerender(<AreaSwitch activeKey="catalog" views={{catalog: <b>catalog</b>}}/>);
  await tick(999); expect(animate).not.toHaveBeenCalled();
  await tick(1); expect(animate).toHaveBeenCalledTimes(2);
  await tick(160); expect(screen.queryByText('old')).toBeNull();
});

it('skips pending frames when reduced motion is enabled during the readiness wait', async () => {
  const view = render(<AreaSwitch activeKey="home" views={{home: <b>old</b>}}/>);
  view.rerender(<AreaSwitch activeKey="catalog" views={{catalog: <b>catalog</b>}}/>);
  reduce = true; act(() => change?.());
  expect(screen.queryByText('old')).toBeNull(); expect(animate).not.toHaveBeenCalled();
  await tick(); expect(animate).not.toHaveBeenCalled();
});
it('finishes an overlapping switch immediately when reduced motion is enabled', async () => {
  const view = render(<AreaSwitch activeKey="home" views={{home: <b>home</b>}} />);
  view.rerender(<AreaSwitch activeKey="assets" views={{assets: <b>assets</b>}} />); await tick();
  reduce = true; act(() => change?.());
  expect(screen.queryByText('home')).toBeNull(); expect(animate.mock.results.every(result => result.value.cancel.mock.calls.length === 1)).toBe(true);
});

it('switches after the readiness cap when the incoming view stays busy', async () => {
  const view = render(<AreaSwitch activeKey="home" views={{home: <button>old</button>}} />);
  view.rerender(<AreaSwitch activeKey="assets" views={{assets: <span className="asset-browser__skeleton">busy</span>}} />); await tick(999);
  expect(screen.getByText('busy').closest<HTMLElement>('[data-motion-view]')?.style.visibility).toBe('hidden');
  await tick(1); await tick(160);
  expect(screen.queryByText('old')).toBeNull();
  expect(screen.getByText('busy').closest('[inert]')).toBeNull();
});

function Cards({surface, count = 2, enabled = true}: {surface: string; count?: number; enabled?: boolean}) {
  const host = useRef<HTMLDivElement>(null);
  useFirstAppearance(host, count, enabled, surface, '.classification-card');
  return <div ref={host}>{Array.from({length: count}, (_, i) => <button className="classification-card" key={i}><img alt=""/>card {i}</button>)}</div>;
}
it('moves custom card containers without fading their thumbnails and remembers each segment separately', () => {
  const tree = (surface: string, count = 2, enabled = true, mounted = true) => <MotionScope>{mounted && <Cards key={surface} surface={surface} count={count} enabled={enabled}/>}</MotionScope>;
  const view = render(tree('folders', 0));
  view.rerender(tree('folders', 2, false)); expect(animate).not.toHaveBeenCalled();
  view.rerender(tree('folders')); expect(animate).toHaveBeenCalledTimes(2);
  expect(animate.mock.contexts.every(tile => (tile as HTMLElement).matches('button.classification-card'))).toBe(true);
  expect(animate.mock.calls[0][0]).toEqual([{transform: 'translateY(8px) scale(.98)'}, {transform: 'none'}]);
  view.rerender(tree('characters')); view.rerender(tree('albums')); view.rerender(tree('artists'));
  expect(animate).toHaveBeenCalledTimes(8);
  view.rerender(tree('folders', 8)); view.rerender(tree('albums', 3));
  view.rerender(tree('artists', 0, true, false)); view.rerender(tree('artists'));
  expect(animate).toHaveBeenCalledTimes(8);
});
it('consumes custom card appearances without motion when reduced motion is enabled', () => {
  reduce = true; const view = render(<MotionScope><Cards surface="folders"/></MotionScope>);
  reduce = false; view.rerender(<MotionScope><Cards surface="folders" count={4}/></MotionScope>);
  expect(animate).not.toHaveBeenCalled();
});

it('creates no stacking layer at rest, so fixed overlays inside a view stack against the app', async () => {
  const view = render(<AreaSwitch activeKey="home" views={{home: <b>home</b>}} />);
  expect(screen.getByText('home').closest<HTMLElement>('[data-motion-view]')?.style.zIndex).toBe('');
  view.rerender(<AreaSwitch activeKey="assets" views={{assets: <b>assets</b>}} />); await tick();
  expect(screen.getByText('assets').closest<HTMLElement>('[data-motion-view]')?.style.zIndex).toBe('1');
  await tick(160);
  expect(screen.getByText('assets').closest<HTMLElement>('[data-motion-view]')?.style.zIndex).toBe('');
});
