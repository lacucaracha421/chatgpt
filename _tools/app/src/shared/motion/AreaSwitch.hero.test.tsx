import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { AreaSwitch, VIEW_HERO_ATTRIBUTE } from './AreaSwitch';
import { collectionHero } from '../../collections/collectionHero';

let reduce = false;
const descriptor = Object.getOwnPropertyDescriptor(document, 'startViewTransition');
type Entry = {update: () => void; finish: () => void};
let entries: Entry[];
const onScreenBox = {left: 100, top: 100, right: 220, bottom: 260, width: 120, height: 160, x: 100, y: 100, toJSON: () => ({})} as DOMRect;
const offScreenBox = {...onScreenBox, top: 5000, bottom: 5160, y: 5000} as DOMRect;
let shelfBox = onScreenBox;
beforeEach(() => {
  vi.useFakeTimers(); reduce = false; shelfBox = onScreenBox; entries = [];
  vi.stubGlobal('matchMedia', () => ({get matches() { return reduce; }, addEventListener() {}, removeEventListener() {}}));
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function(this: HTMLElement) {
    return this.classList.contains('cs-front') ? shelfBox : onScreenBox;
  });
  Object.defineProperty(document, 'startViewTransition', {configurable: true, value: (update: () => void) => {
    let finish!: () => void; const finished = new Promise<void>(resolve => { finish = resolve; });
    entries.push({update, finish});
    return {ready: Promise.resolve(), finished, updateCallbackDone: Promise.resolve(), skipTransition: vi.fn()};
  }});
});
afterEach(() => {
  cleanup(); vi.restoreAllMocks(); vi.useRealTimers(); vi.unstubAllGlobals();
  if (descriptor) Object.defineProperty(document, 'startViewTransition', descriptor); else Reflect.deleteProperty(document, 'startViewTransition');
  document.documentElement.removeAttribute('data-area-view-transition');
});
const tick = async (ms = 64) => { for (let left = ms; left > 0; left -= 16) await act(async () => { await vi.advanceTimersByTimeAsync(16); }); };

// The shelf (a lifted case among others) and the work screen (the stage case) of collection "w1".
const shelf = <div className="collection-list">
  <button className="collection-card" data-collection-id="w0" aria-selected="false"><span className="cs-box"><span className="cs-front" data-testid="other-front"/></span></button>
  <button className="collection-card" data-collection-id="w1" aria-selected="true"><span className="cs-box"><span className="cs-front" data-testid="shelf-front"/></span></button>
</div>;
const work = <div className="work-stage"><div className="work-case-slot"><div className="kase"><span className="k-lid"><span className="k-front" data-testid="stage-front"/></span></div></div></div>;
const views = (key: string) => ({[key]: key === 'collections' ? shelf : key === 'collection-work' ? work : <b>notes</b>});
const tree = (key: string, hero = true) => <AreaSwitch viewTransitions activeKey={key} views={views(key)}
  hero={hero ? (area, host) => collectionHero(area, host, 'w1') : undefined}/>;
const named = () => Array.from(document.querySelectorAll(`[${VIEW_HERO_ATTRIBUTE}]`)).map(element => element.getAttribute('data-testid'));

it.each([['collections', 'collection-work', 'shelf-front', 'stage-front'], ['collection-work', 'collections', 'stage-front', 'shelf-front']])('morphs the shared object from %s to %s: named on the old view for the snapshot, on the new one after the commit', async (from, to, oldName, newName) => {
  const view = render(tree(from));
  view.rerender(tree(to));
  await tick();
  expect(entries).toHaveLength(1);
  // Before the old snapshot: only the old object carries the name, and the document is in hero mode.
  expect(named()).toEqual([oldName]);
  expect(document.documentElement).toHaveAttribute('data-area-view-transition', 'hero');
  act(() => entries[0].update());
  // After the commit: the name moved to the new view's object; never two at once.
  expect(named()).toEqual([newName]);
  await act(async () => entries[0].finish());
  expect(named()).toEqual([]);
  expect(document.documentElement).not.toHaveAttribute('data-area-view-transition');
});

it('names nothing when the shelf item is off screen, so the page only cross-fades', async () => {
  shelfBox = offScreenBox;
  const view = render(tree('collection-work'));
  view.rerender(tree('collections'));
  await tick();
  expect(entries).toHaveLength(1);
  expect(named()).toEqual([]);
  expect(document.documentElement).toHaveAttribute('data-area-view-transition', '');
  act(() => entries[0].update());
  expect(named()).toEqual([]);
  await act(async () => entries[0].finish());
});

it('has no morph under reduced motion', async () => {
  reduce = true;
  const view = render(tree('collections'));
  view.rerender(tree('collection-work'));
  await tick();
  expect(entries).toHaveLength(1);
  expect(named()).toEqual([]);
  expect(document.documentElement.getAttribute('data-area-view-transition')).toBe('');
  act(() => entries[0].update());
  expect(named()).toEqual([]);
  await act(async () => entries[0].finish());
});

it('leaves other area switches unchanged: no hero, plain snapshot', async () => {
  const view = render(tree('notes', false));
  view.rerender(tree('collections', false));
  await tick();
  expect(entries).toHaveLength(1);
  expect(document.documentElement.getAttribute('data-area-view-transition')).toBe('');
  act(() => entries[0].update());
  expect(named()).toEqual([]);
  expect(screen.getByTestId('shelf-front')).toBeTruthy();
  await act(async () => entries[0].finish());
});

it('morphs the object on the gentle spring with a quick image cross-fade and fast page swap', () => {
  const css = readFileSync('src/shared/motion/viewTransitions.css', 'utf8');
  expect(css).toContain('html[data-area-view-transition="hero"] [data-view-hero] { view-transition-name: work-hero !important; }');
  expect(css).toMatch(/::view-transition-group\(work-hero\) \{ animation-duration: 340ms; animation-timing-function: var\(--spring-gentle/);
  expect(css).toMatch(/::view-transition-new\(work-hero\) \{ animation-duration: 120ms;/);
  expect(css).toMatch(/hero"\]::view-transition-old\(index\) \{ animation-duration: 90ms; \}/);
  expect(css).toMatch(/hero"\]::view-transition-group\(index\) \{ animation-duration: 180ms; \}/);
});
