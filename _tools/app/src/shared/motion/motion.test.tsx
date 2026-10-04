import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { StrictMode, useEffect, useRef, useState } from 'react';
import { AreaSwitch, AreaVisible, MotionScope, READY_CAP_MS } from './AreaSwitch';
import { useFirstAppearance } from './useFirstAppearance';
import { EASE_SNAPPY, EASE_SPRING, EASE_STANDARD, SNAPPY_MS, SPRING_FALLBACK, snappySpringEasing, springEasing } from './curves';
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
const tick = async (ms = 64) => {
  for (let remaining = ms; remaining > 0; remaining -= 16) await act(async () => { await vi.advanceTimersByTimeAsync(Math.min(16, remaining)); });
};

it('shares the snappy prototype samples with CSS and preserves both spring fallbacks', () => {
  const css = readFileSync('src/styles/tokens.css', 'utf8');
  expect(css).toContain(`--spring-snappy: ${EASE_SNAPPY}`);
  expect(css).toContain(`--spring-snappy-ms: ${SNAPPY_MS}ms`);
  expect(css).toContain('@supports (transition-timing-function: linear(0, 1))');
  vi.stubGlobal('CSS', {supports: () => false}); expect(springEasing()).toBe(SPRING_FALLBACK);
  expect(snappySpringEasing()).toBe(EASE_STANDARD);
  vi.stubGlobal('CSS', {supports: () => true}); expect(springEasing()).toBe(EASE_SPRING);
  expect(snappySpringEasing()).toBe(EASE_SNAPPY);
});

it('keeps the exact old DOM until both opacity fades finish together', async () => {
  const tree = (loading: boolean) => <AreaSwitch activeKey="assets" views={{assets: loading ? <span className="asset-browser__skeleton" style={{visibility: 'visible'}}>waiting</span> : <button>new</button>}} />;
  const view = render(<AreaSwitch activeKey="home" views={{home: <button>old</button>}} />);
  const old = screen.getByText('old');
  view.rerender(tree(true)); await tick();
  expect(old.isConnected).toBe(true); expect(old.closest('[inert]')).not.toBeNull();
  expect(old.closest<HTMLElement>('[data-motion-view]')?.style.visibility).toBe('');
  expect(screen.getByText('waiting').closest<HTMLElement>('[data-motion-view]')?.style.visibility).toBe('hidden');
  expect(screen.getByText('waiting').style.visibility).toBe('visible');
  expect(screen.getByText('waiting').closest<HTMLElement>('[data-motion-view]')?.style.opacity).toBe('0');
  expect(screen.getByText('waiting').closest<HTMLElement>('[data-motion-view]')?.style.display).toBe('');
  expect(old).toBeVisible();
  expect(screen.getByText('waiting')).not.toBeVisible();
  expect(animate).not.toHaveBeenCalled();
  view.rerender(tree(false)); await tick(16);
  expect(old).toBeVisible();
  expect(screen.getByText('new')).not.toBeVisible();
  expect(screen.getByText('new').closest('[inert]')).not.toBeNull();
  await tick(48);
  expect(old).toBeVisible();
  expect(old.closest('[inert][aria-hidden="true"]')).not.toBeNull();
  expect(old.closest<HTMLElement>('[data-motion-view]')?.style.zIndex).toBe('0');
  expect(screen.getByRole('button', {name: 'new'})).toBeVisible();
  expect(screen.getByText('new').closest<HTMLElement>('[data-motion-view]')?.style.opacity).toBe('');
  expect(view.container.querySelectorAll('[data-motion-view]')).toHaveLength(2);
  expect(screen.getByText('new').closest<HTMLElement>('[data-motion-view]')?.style.zIndex).toBe('1');
  expect(animate).toHaveBeenCalledTimes(2);
  expect(animate.mock.contexts[0]).toBe(screen.getByText('new').closest('[data-motion-view]'));
  expect(animate.mock.calls[0]).toEqual([
    [{opacity: 0}, {opacity: 1}],
    {duration: 150, easing: EASE_STANDARD},
  ]);
  expect(animate.mock.contexts[1]).toBe(old.closest('[data-motion-view]'));
  expect(animate.mock.calls[1]).toEqual([
    [{opacity: 1}, {opacity: 0}], {duration: 150, easing: EASE_STANDARD, fill: 'forwards'},
  ]);
  view.rerender(tree(false)); await tick(149);
  expect(old).toBeVisible();
  await tick(1);
  expect(old.isConnected).toBe(false);
  expect(view.container.querySelectorAll('[data-motion-view]')).toHaveLength(1);
  expect(animate).toHaveBeenCalledTimes(2);
});

it('uses a 120ms opacity cross under reduced motion', async () => {
  reduce = true;
  const view = render(<AreaSwitch activeKey="home" views={{home: <b>old</b>}} />);
  view.rerender(<AreaSwitch activeKey="assets" views={{assets: <span className="library-content__deferred"/>}} />); await tick();
  expect(screen.getByText('old')).toBeTruthy();
  view.rerender(<AreaSwitch activeKey="assets" views={{assets: <b>new</b>}} />);
  expect(screen.getByText('old')).toBeVisible();
  await tick(32);
  expect(animate).toHaveBeenNthCalledWith(1, [{opacity: 0}, {opacity: 1}], {duration: 120, easing: EASE_STANDARD});
  expect(animate).toHaveBeenNthCalledWith(2, [{opacity: 1}, {opacity: 0}], {duration: 120, easing: EASE_STANDARD, fill: 'forwards'});
  await tick(119); expect(screen.getByText('old')).toBeVisible();
  await tick(1); expect(screen.queryByText('old')).toBeNull();
});

it.each([['assets', 'collections'], ['collections', 'assets']])('freezes %s geometry while %s enters at its final index width', async (from, to) => {
  const indexFor = (key: string) => key === 'assets' ? 208 : 0;
  const shown = vi.fn();
  function Shell({activeKey}: {activeKey: string}) {
    const [indexWidth, setIndexWidth] = useState(indexFor(from));
    return <div data-test-index-width={indexWidth}><AreaSwitch activeKey={activeKey}
      incomingWidthDelta={indexWidth - indexFor(activeKey)} onShown={key => {
        // The shell must change with the opacity clock, never while the destination prepares.
        expect(animate).toHaveBeenCalledTimes(2);
        shown(key); setIndexWidth(indexFor(key));
      }} views={{[activeKey]: <b>{activeKey}</b>}}/></div>;
  }
  // jsdom has no layout: model only the shell's column width and the actual host styles.
  const rects = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    const indexWidth = Number(this.closest('[data-test-index-width]')?.getAttribute('data-test-index-width'));
    const fixed = this.style.position === 'fixed';
    const delta = /calc\(100% ([+-]) (\d+)px\)/.exec(this.style.width);
    const left = fixed ? Number.parseFloat(this.style.left) : 64 + indexWidth + (Number.parseFloat(this.style.left) || 0);
    const top = fixed ? Number.parseFloat(this.style.top) : 88;
    const width = fixed ? Number.parseFloat(this.style.width) : 1200 - indexWidth + (delta ? Number(delta[2]) * (delta[1] === '+' ? 1 : -1) : 0);
    return {left, top, width, height: 720, right: left + width, bottom: top + 720, x: left, y: top, toJSON() {}};
  });
  try {
    const view = render(<Shell activeKey={from}/>);
    const outgoing = view.container.querySelector<HTMLElement>(`[data-motion-view="${from}"]`)!;
    const {left, top, width, height} = outgoing.getBoundingClientRect();
    const lastFrame = {left, top, width, height};
    view.rerender(<Shell activeKey={to}/>);
    const incoming = view.container.querySelector<HTMLElement>(`[data-motion-view="${to}"]`)!;
    expect(incoming.getBoundingClientRect().width).toBe(1200 - indexFor(to));
    expect(incoming.getBoundingClientRect().left).toBe(64 + indexFor(to));
    await tick(32);
    expect(shown).not.toHaveBeenCalled();
    expect(outgoing.style.position).toBe('fixed');
    expect(outgoing.style.inset).toBe('auto');
    expect(outgoing.style.contain).toBe('layout paint size');
    expect(outgoing.style.width).toBe(`${lastFrame.width}px`);
    expect(outgoing.style.height).toBe(`${lastFrame.height}px`);
    expect(outgoing.getBoundingClientRect()).toMatchObject(lastFrame);
    expect(incoming.style.opacity).toBe('0');
    await tick(16); expect(shown).not.toHaveBeenCalled();
    await tick(16);
    expect(shown).toHaveBeenCalledExactlyOnceWith(to);
    expect(view.container.firstElementChild).toHaveAttribute('data-test-index-width', String(indexFor(to)));
    expect(incoming.style.width).toBe('');
    expect(incoming.style.opacity).toBe('');
    expect(incoming.getBoundingClientRect().width).toBe(1200 - indexFor(to));
    expect(incoming.getBoundingClientRect().left).toBe(64 + indexFor(to));
    expect(outgoing.getBoundingClientRect()).toMatchObject(lastFrame);
    await tick(149);
    expect(outgoing.isConnected).toBe(true);
    expect(outgoing.style.width).toBe(`${lastFrame.width}px`);
    await tick(1);
    expect(outgoing.isConnected).toBe(false);
  } finally { rects.mockRestore(); }
});

it('preserves the immediate ready swap when animation APIs are unavailable', () => {
  delete (HTMLElement.prototype as Partial<HTMLElement>).animate;
  const view = render(<AreaSwitch activeKey="home" views={{home: <b>old</b>}} />);
  view.rerender(<AreaSwitch activeKey="assets" views={{assets: <b className="asset-browser__skeleton">waiting</b>}} />);
  expect(screen.getByText('old')).toBeVisible();
  expect(screen.getByText('waiting')).not.toBeVisible();
  view.rerender(<AreaSwitch activeKey="assets" views={{assets: <b>new</b>}} />);
  expect(screen.queryByText('old')).toBeNull();
  expect(screen.getByText('new')).toBeVisible();
  expect(vi.getTimerCount()).toBe(0);
});

it('cancels superseded transitions and never shows the abandoned pending view', async () => {
  const view = render(<AreaSwitch activeKey="home" views={{home: <b>old</b>}} />);
  view.rerender(<AreaSwitch activeKey="assets" views={{assets: <b className="asset-browser__skeleton">pending</b>}} />); await tick();
  view.rerender(<AreaSwitch activeKey="notes" views={{notes: <b>notes</b>}} />); await tick();
  expect(screen.queryByText('pending')).toBeNull(); expect(screen.getByText('old')).toBeVisible();
  await tick(180); expect(screen.queryByText('old')).toBeNull();
  expect(screen.getByText('notes')).toBeVisible();
});

it('preserves retained surface DOM and mounts while hiding it on departure and showing it on revisit', async () => {
  const mounts = vi.fn();
  function Notes({active}: {active: boolean}) {useEffect(() => {mounts();}, []); return <button style={{display: active ? undefined : 'none'}}>notes</button>;}
  const tree = (activeKey: string) => <AreaSwitch activeKey={activeKey} retained={['notes']} views={{notes: <Notes active={activeKey === 'notes'}/>, home: <b>home</b>}} />;
  const view = render(tree('notes')); const notes = screen.getByText('notes');
  view.rerender(tree('home')); expect(notes.style.display).toBe(''); await tick();
  expect(notes.isConnected).toBe(true); expect(notes.style.display).toBe('');
  expect(notes.closest('[inert]')).not.toBeNull();
  await tick(180); expect(notes.style.display).toBe('none');
  expect(notes.closest<HTMLElement>('[data-motion-view]')?.style.position).toBe('');
  expect(notes.closest<HTMLElement>('[data-motion-view]')?.style.contain).toBe('');
  view.rerender(tree('notes')); await tick();
  expect(screen.getByRole('button', {name: 'notes'})).toBe(notes); expect(mounts).toHaveBeenCalledTimes(1);
});

it('settles a ready retained Home before its entrance and plays its entrance on every revisit', async () => {
  const tree = (activeKey: string) => <AreaSwitch activeKey={activeKey} retained={['home']} views={{home: <b>home</b>, assets: <b>assets</b>}} />;
  const view = render(tree('home'));
  const home = screen.getByText('home');
  view.rerender(tree('assets')); await tick();
  expect(home).toBeVisible();
  expect(animate).toHaveBeenCalledTimes(2);
  view.rerender(tree('home')); await tick(32);
  expect(home).toBeVisible();
  expect(screen.getByText('assets')).toBeVisible();
  expect(screen.getByText('assets').closest('[inert]')).not.toBeNull();
  expect(animate).toHaveBeenCalledTimes(4);
  expect(animate.mock.contexts[2]).toBe(home.closest('[data-motion-view]'));
  view.rerender(tree('assets')); await tick();
  view.rerender(tree('home')); await tick(32);
  expect(animate).toHaveBeenCalledTimes(8);
  expect(animate.mock.contexts[6]).toBe(home.closest('[data-motion-view]'));
  await tick(180);
  expect(screen.queryByText('assets')).toBeNull();
  expect(vi.getTimerCount()).toBe(0);
});

function Tiles({count}: {count: number}) {
  const host = useRef<HTMLDivElement>(null); useFirstAppearance(host, count);
  return <div ref={host}>{Array.from({length: count}, (_, i) => <b data-asset-id={i} key={i}>tile {i}</b>)}</div>;
}
it('animates the first loaded tiles on every mount, caps stagger at 18, and skips later batches', () => {
  const tree = (count: number, mount = true) => <MotionScope>{mount && <Tiles count={count}/>}</MotionScope>;
  const view = render(tree(0)); expect(animate).not.toHaveBeenCalled();
  view.rerender(tree(22)); expect(animate).toHaveBeenCalledTimes(22);
  expect(animate.mock.calls[0][0]).toEqual([{opacity: 0, transform: 'translateY(8px) scale(.98)'}, {opacity: 1, transform: 'none'}]);
  expect(animate.mock.calls[21][1]).toEqual({duration: 560, delay: 432, easing: SPRING_FALLBACK, fill: 'backwards'});
  view.rerender(tree(24)); view.rerender(tree(4)); view.rerender(tree(0)); view.rerender(tree(22));
  expect(animate).toHaveBeenCalledTimes(22);
  view.rerender(tree(0, false)); view.rerender(tree(22));
  expect(animate).toHaveBeenCalledTimes(44);
});
it('rearms retained tiles while hidden and waits for their first enabled painted batch on revisit', () => {
  const tree = (visible: boolean, count: number, enabled = true) => <AreaVisible.Provider value={visible}><Cards surface="retained" count={count} enabled={enabled}/></AreaVisible.Provider>;
  const view = render(tree(true, 2)); expect(animate).toHaveBeenCalledTimes(2);
  const first = animate.mock.results.map(result => result.value);
  view.rerender(tree(false, 3));
  first.forEach(animation => expect(animation.cancel).toHaveBeenCalledOnce());
  view.rerender(tree(false, 4)); expect(animate).toHaveBeenCalledTimes(2);
  view.rerender(tree(true, 4, false)); expect(animate).toHaveBeenCalledTimes(2);
  view.rerender(tree(true, 4)); expect(animate).toHaveBeenCalledTimes(6);
  view.rerender(tree(true, 8)); expect(animate).toHaveBeenCalledTimes(6);
});
it('merges the first tile batch into the area entrance, including a retained revisit', async () => {
  const tree = (activeKey: string, count = 2) => <AreaSwitch activeKey={activeKey} retained={['assets']} views={{assets: <Tiles count={count}/>, home: <b>home</b>}}/>;
  const view = render(tree('home'));
  expect(animate).not.toHaveBeenCalled();
  view.rerender(tree('assets')); expect(animate).not.toHaveBeenCalled();
  await tick();
  const tiles = () => animate.mock.contexts.filter(host => (host as HTMLElement).matches('[data-asset-id]'));
  expect(tiles()).toHaveLength(0);
  view.rerender(tree('assets', 3)); expect(tiles()).toHaveLength(0);
  view.rerender(tree('home', 3)); await tick();
  view.rerender(tree('home', 4)); expect(tiles()).toHaveLength(0);
  view.rerender(tree('assets', 4));
  expect(tiles()).toHaveLength(0);
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
  expect(screen.getByText('old')).toBeVisible();
  await tick(180);
  expect(screen.queryByText('old')).toBeNull();
});

it('keeps the old view visible through incoming layout before replacing it in one frame', async () => {
  const view = render(<AreaSwitch activeKey="home" views={{home: <b>old</b>}} />);
  const tree = (ready: boolean) => <AreaSwitch activeKey="catalog" views={{catalog: <button>catalog</button>}} ready={() => ready}/>;
  view.rerender(tree(false)); await tick(0);
  view.rerender(tree(true));
  expect(animate).not.toHaveBeenCalled();
  await tick(16); expect(animate).not.toHaveBeenCalled();
  expect(screen.getByText('old').closest<HTMLElement>('[data-motion-view]')?.style.visibility).toBe('');
  expect(screen.getByText('catalog').closest<HTMLElement>('[data-motion-view]')?.style.visibility).toBe('hidden');
  await tick(16); expect(animate).not.toHaveBeenCalled();
  await tick(32); expect(animate).toHaveBeenCalledTimes(2);
  expect(screen.getByText('old')).toBeVisible();
  await tick(180);
  expect(screen.queryByText('old')).toBeNull();
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
  await tick(16); expect(animate).not.toHaveBeenCalled();
  await tick(32); expect(animate).toHaveBeenCalledTimes(2);
  expect(screen.queryByText('catalog')).toBeNull();
  expect(screen.getByText('old')).toBeVisible();
  await tick(180);
  expect(screen.queryByText('old')).toBeNull();
  expect(screen.getByText('notes').closest('[inert]')).toBeNull();
});

it('keeps the 1s cap even when rendering frames are suspended', async () => {
  vi.stubGlobal('requestAnimationFrame', vi.fn(() => 99));
  vi.stubGlobal('cancelAnimationFrame', vi.fn());
  const view = render(<AreaSwitch activeKey="home" views={{home: <b>old</b>}}/>);
  view.rerender(<AreaSwitch activeKey="catalog" views={{catalog: <b>catalog</b>}}/>);
  await tick(999); expect(animate).not.toHaveBeenCalled();
  await tick(1); expect(animate).not.toHaveBeenCalled();
  expect(screen.queryByText('old')).toBeNull();
});

it('waits two frames after the shown commit, merging its tiles and releasing promotion on finish', async () => {
  const shown = vi.fn();
  const view = render(<AreaSwitch activeKey="home" views={{home: <b>old</b>}}/>);
  view.rerender(<AreaSwitch activeKey="assets" onShown={shown} views={{assets: <Tiles count={18}/>}}/>);
  await tick(32);
  expect(shown).not.toHaveBeenCalled();
  const incoming = view.container.querySelector<HTMLElement>('[data-motion-view="assets"]')!;
  expect(incoming.style.opacity).toBe('0');
  expect(incoming).toHaveAttribute('inert');
  expect(screen.getByText('old')).toBeVisible();
  expect(animate).not.toHaveBeenCalled();
  await tick(16); expect(animate).not.toHaveBeenCalled();
  await tick(16); expect(animate).toHaveBeenCalledTimes(2);
  expect(shown).toHaveBeenCalledExactlyOnceWith('assets');
  expect(animate.mock.contexts[0]).toBe(incoming);
  expect(incoming).not.toHaveAttribute('inert');
  expect(incoming.style.willChange).toBe('opacity');
  await tick(180);
  expect(incoming.style.willChange).toBe('');
  expect(animate).toHaveBeenCalledTimes(2);
});

it('keeps the old view painted while first-viewport lazy images decode after the shell commit', async () => {
  const settling = vi.fn();
  const view = render(<AreaSwitch activeKey="home" views={{home: <b>old</b>}}/>);
  view.rerender(<AreaSwitch activeKey="assets" onSettlingChange={settling} views={{assets: <img src="/thumb" loading="lazy" alt="new"/>}}/>);
  const incoming = view.container.querySelector<HTMLElement>('[data-motion-view="assets"]')!;
  const image = incoming.querySelector('img')!;
  const rect = () => ({top: 0, bottom: 100, left: 0, right: 100, width: 100, height: 100, x: 0, y: 0, toJSON() {}});
  incoming.getBoundingClientRect = rect; image.getBoundingClientRect = rect;
  let finish!: () => void; image.decode = () => new Promise<void>(resolve => {finish = resolve;});
  await tick();
  expect(image.loading).toBe('eager'); expect(incoming.style.opacity).toBe('0');
  expect(settling).toHaveBeenLastCalledWith(true);
  expect(screen.getByText('old')).toBeVisible(); expect(animate).not.toHaveBeenCalled();
  await act(async () => finish());
  expect(animate).toHaveBeenCalledTimes(2); expect(incoming.style.opacity).toBe('');
  expect(settling).toHaveBeenLastCalledWith(false);
  await tick(180); expect(screen.queryByText('old')).toBeNull();
});

it('does not reveal an abandoned tab when a switch interrupts its image preparation', async () => {
  const shown = vi.fn();
  const view = render(<AreaSwitch activeKey="home" onShown={shown} views={{home: <b>old</b>}}/>);
  view.rerender(<AreaSwitch activeKey="assets" onShown={shown} views={{assets: <img src="/slow" alt="abandoned"/>}}/>);
  const incoming = view.container.querySelector<HTMLElement>('[data-motion-view="assets"]')!;
  const image = incoming.querySelector('img')!;
  const rect = () => ({top: 0, bottom: 100, left: 0, right: 100, width: 100, height: 100, x: 0, y: 0, toJSON() {}});
  incoming.getBoundingClientRect = rect; image.getBoundingClientRect = rect;
  let finish!: () => void; image.decode = () => new Promise<void>(resolve => {finish = resolve;});
  await tick();
  expect(shown).not.toHaveBeenCalled();
  view.rerender(<AreaSwitch activeKey="notes" onShown={shown} views={{notes: <b aria-busy="true">pending</b>}}/>);
  expect(screen.getByText('old')).toBeVisible();
  expect(screen.getByText('old').closest<HTMLElement>('[data-motion-view]')?.style.opacity).toBe('');
  expect(screen.queryByAltText('abandoned')).toBeNull();
  // The abandoned destination never changed the painted shell.
  expect(shown).not.toHaveBeenCalled();
  await act(async () => finish()); await tick(300);
  expect(animate).not.toHaveBeenCalled(); expect(screen.getByText('old')).toBeVisible();
});

it('settles the shown commit before a reduced-motion entrance', async () => {
  const view = render(<AreaSwitch activeKey="home" views={{home: <b>old</b>}}/>);
  view.rerender(<AreaSwitch activeKey="catalog" views={{catalog: <b>catalog</b>}}/>);
  reduce = true; act(() => change?.());
  expect(screen.getByText('old')).toBeVisible(); expect(animate).not.toHaveBeenCalled();
  await tick(32); expect(animate).toHaveBeenCalledTimes(2);
  expect(animate.mock.calls[0][1].duration).toBe(120);
  await tick(120); expect(screen.queryByText('old')).toBeNull();
});
it('cleans up pending observers, frames and the cap on unmount', async () => {
  const disconnect = vi.spyOn(MutationObserver.prototype, 'disconnect');
  const view = render(<AreaSwitch activeKey="home" views={{home: <b>home</b>}} />);
  view.rerender(<AreaSwitch activeKey="assets" views={{assets: <b>assets</b>}} />);
  view.unmount();
  expect(disconnect).toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
  await tick(1200);
  expect(animate).not.toHaveBeenCalled();
  disconnect.mockRestore();
});

it('switches after the readiness cap when the incoming view stays busy', async () => {
  const disconnect = vi.spyOn(MutationObserver.prototype, 'disconnect');
  const view = render(<AreaSwitch activeKey="home" views={{home: <button>old</button>}} />);
  view.rerender(<AreaSwitch activeKey="assets" views={{assets: <span className="asset-browser__skeleton">busy</span>}} />); await tick(999);
  expect(screen.getByText('busy').closest<HTMLElement>('[data-motion-view]')?.style.visibility).toBe('hidden');
  await tick(1);
  expect(vi.getTimerCount()).toBe(0);
  expect(screen.queryByText('old')).toBeNull();
  expect(screen.getByText('busy').closest('[inert]')).toBeNull();
  expect(screen.getByText('busy')).toBeVisible();
  expect(animate).not.toHaveBeenCalled();
  expect(disconnect).toHaveBeenCalled();
  disconnect.mockRestore();
});

it('keeps the Collections five-times readiness cap and commits shell state only with the view', async () => {
  const shown = vi.fn();
  const view = render(<AreaSwitch activeKey="assets" onShown={shown} views={{assets: <b>old</b>}} />);
  view.rerender(<AreaSwitch activeKey="collections" waitForReady onShown={shown} views={{collections: <b aria-busy="true">shelf</b>}} />);
  await tick(READY_CAP_MS * 5 - 1);
  expect(screen.getByText('old')).toBeVisible();
  expect(screen.getByText('shelf')).not.toBeVisible();
  expect(shown).not.toHaveBeenCalled();
  await tick(1);
  expect(screen.queryByText('old')).toBeNull();
  expect(screen.getByText('shelf')).toBeVisible();
  expect(shown).toHaveBeenCalledExactlyOnceWith('collections');
  expect(animate).not.toHaveBeenCalled();
});

function Cards({surface, count = 2, enabled = true}: {surface: string; count?: number; enabled?: boolean}) {
  const host = useRef<HTMLDivElement>(null);
  useFirstAppearance(host, count, enabled, surface, '.classification-card');
  return <div ref={host}>{Array.from({length: count}, (_, i) => <button className="classification-card" key={i}><img alt=""/>card {i}</button>)}</div>;
}
it('moves custom card containers without fading their thumbnails on every segment visit', () => {
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
  expect(animate).toHaveBeenCalledTimes(21);
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
  expect(animate).toHaveBeenCalledTimes(2);
  expect(animate.mock.calls[0][1].fill).toBeUndefined();
  await tick(180);
  expect(screen.getByText('assets').closest<HTMLElement>('[data-motion-view]')?.style.transform).toBe('');
  expect(screen.getByText('assets').closest<HTMLElement>('[data-motion-view]')?.style.opacity).toBe('');
  expect(screen.getByText('assets').closest<HTMLElement>('[data-motion-view]')?.style.zIndex).toBe('');
});

it('cancels an area entrance when reduced motion turns on or the stage unmounts', async () => {
  const view = render(<AreaSwitch activeKey="home" views={{home: <b>home</b>}}/>);
  view.rerender(<AreaSwitch activeKey="assets" views={{assets: <b>assets</b>}}/>); await tick();
  expect(animate).toHaveBeenCalledTimes(2);
  const entrance = animate.mock.results[0].value;
  reduce = true; act(() => change?.());
  expect(entrance.cancel).toHaveBeenCalledOnce();
  expect(screen.getByText('assets')).toBeVisible();
  expect(screen.queryByText('home')).toBeNull();
  view.unmount();
  expect(entrance.cancel).toHaveBeenCalledTimes(2);
});
