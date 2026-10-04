import {act, cleanup, fireEvent, render, screen} from '@testing-library/react';
import {afterEach, describe, expect, it, vi} from 'vitest';
import {readFileSync} from 'node:fs';
import {useMotionSurface} from '../src/shared/ui/useMotionSurface';
import {motionDefaults, motionSpring} from '../src/shared/motion/curves';
import {useLayerCovered} from './motion';
import {Fold} from './Fold';
import {flyOff, riseIn} from './CharacterReview';

const surfaceCSS = readFileSync('src/styles/surface-motion.css', 'utf8');
const foldCSS = readFileSync('mobile-client/fold.css', 'utf8');

afterEach(() => {
  cleanup();
  document.querySelectorAll('[data-motion-ghost], [data-review-ghost]').forEach(node => node.remove());
  vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals();
});

function reducedMotion(reduced: boolean) {
  vi.stubGlobal('matchMedia', vi.fn(() => ({matches: reduced, addEventListener: vi.fn(), removeEventListener: vi.fn()})));
}

/** The App pattern: a conditional full-screen layer whose motion hook lives in the parent. */
function Layered({open, onPage}: {open: boolean; onPage?: () => void}) {
  const layer = useMotionSurface('layer');
  return <div>
    <button onClick={onPage}>page</button>
    {open && <div className="settings-layer" ref={layer}><button>inside</button><iframe className="fault-frame" title="game" src="about:blank"/></div>}
  </div>;
}

describe('full-screen layers', () => {
  it('push in from the right on the gentle spring and pop back the same way (CSS)', () => {
    const rule = /\[data-motion="layer"\] \{([^}]*)\}/.exec(surfaceCSS)?.[1] ?? '';
    expect(rule).toContain('--surface-x: 100%');
    expect(rule).toContain('--surface-ease: var(--spring-gentle)');
    expect(rule).toContain('--surface-scale: 1');
  });

  it.each([false, true])('enter from their first frame, then keep an inert copy until the exit ends (reduced=%s)', reduced => {
    reducedMotion(reduced); vi.useFakeTimers();
    const onPage = vi.fn();
    const view = render(<Layered open onPage={onPage}/>);
    const layer = document.querySelector<HTMLElement>('.settings-layer')!;
    expect(layer.dataset.motion).toBe('layer');
    expect(layer.hasAttribute('data-motion-entering')).toBe(true);
    act(() => vi.advanceTimersToNextFrame());
    expect(layer.hasAttribute('data-motion-entering')).toBe(false);
    vi.spyOn(layer, 'getBoundingClientRect').mockReturnValue({width: 800, height: 1200} as DOMRect);

    view.rerender(<Layered open={false} onPage={onPage}/>);
    // The real layer is gone at once: its handlers, focus and Back no longer apply.
    expect(screen.queryByRole('button', {name: 'inside'})).toBeNull();
    const ghost = document.querySelector<HTMLElement>('.settings-layer[data-motion-ghost]')!;
    expect(ghost).not.toBeNull();
    expect(ghost.inert).toBe(true);
    expect(ghost.getAttribute('aria-hidden')).toBe('true');
    // A copied frame would load the game again; its box stays empty instead.
    expect(ghost.querySelector('iframe')).toBeNull();
    expect(ghost.querySelector('div.fault-frame')).not.toBeNull();
    // The page beneath takes input during the exit.
    const page = screen.getByRole('button', {name: 'page'});
    expect(page.closest('[inert]')).toBeNull();
    fireEvent.click(page);
    expect(onPage).toHaveBeenCalledTimes(1);

    act(() => vi.advanceTimersToNextFrame());
    expect(ghost.dataset.state).toBe('closed');
    const exit = reduced ? motionDefaults.micro : motionSpring('gentle').duration * .7;
    act(() => vi.advanceTimersByTime(exit - 1));
    expect(ghost.isConnected).toBe(true);
    act(() => vi.advanceTimersByTime(1));
    expect(ghost.isConnected).toBe(false);
  });

  it('turns back from the leaving copy when reopened mid-exit', () => {
    reducedMotion(false); vi.useFakeTimers();
    const view = render(<Layered open/>);
    act(() => vi.advanceTimersToNextFrame());
    vi.spyOn(document.querySelector<HTMLElement>('.settings-layer')!, 'getBoundingClientRect').mockReturnValue({width: 800} as DOMRect);
    view.rerender(<Layered open={false}/>);
    act(() => vi.advanceTimersToNextFrame());
    const ghost = document.querySelector('.settings-layer[data-motion-ghost]')!;
    view.rerender(<Layered open/>);
    expect(ghost.isConnected).toBe(false);
    const layer = document.querySelector<HTMLElement>('.settings-layer')!;
    // It continues from the copy's painted position instead of restarting from the edge.
    expect(layer.hasAttribute('data-motion-entering')).toBe(false);
    expect(screen.getByRole('button', {name: 'inside'})).toBeTruthy();
  });

  function Covered({open}: {open: boolean}) { return <span>{useLayerCovered(open) ? 'covered' : 'open'}</span>; }
  it.each([false, true])('hide the page beneath only once pushed in, and show it again at once on close (reduced=%s)', reduced => {
    reducedMotion(reduced); vi.useFakeTimers();
    const view = render(<Covered open/>);
    expect(screen.getByText('open')).toBeTruthy();
    const enter = reduced ? motionDefaults.micro : motionSpring('gentle').duration;
    act(() => vi.advanceTimersByTime(enter - 1));
    expect(screen.getByText('open')).toBeTruthy();
    act(() => vi.advanceTimersByTime(1));
    expect(screen.getByText('covered')).toBeTruthy();
    view.rerender(<Covered open={false}/>);
    expect(screen.getByText('open')).toBeTruthy();
  });
});

describe('fold contents', () => {
  it('unfold by height and opacity, and fold back faster (CSS)', () => {
    expect(foldCSS).toMatch(/\.tablet-fold \{[^}]*grid-template-rows:1fr[^}]*transition:grid-template-rows var\(--motion-medium\)/);
    expect(foldCSS).toMatch(/\.tablet-fold\[data-entering\], \.tablet-fold\[data-open="false"\] \{ grid-template-rows:0fr; opacity:0; \}/);
    expect(foldCSS).toContain('calc(var(--motion-medium) * var(--motion-exit-ratio))');
    expect(foldCSS).toMatch(/prefers-reduced-motion:reduce\) \{ \.tablet-fold\.tablet-fold \{ transition:opacity var\(--motion-micro\)/);
  });

  it.each([false, true])('stay mounted and out of reach while folding, then leave (reduced=%s)', reduced => {
    reducedMotion(reduced); vi.useFakeTimers();
    const view = render(<Fold open={false}><button>row</button></Fold>);
    expect(document.querySelector('.tablet-fold')).toBeNull();
    view.rerender(<Fold open><button>row</button></Fold>);
    const fold = document.querySelector<HTMLElement>('.tablet-fold')!;
    expect(fold.hasAttribute('data-entering')).toBe(true);
    act(() => vi.advanceTimersToNextFrame());
    expect(fold.hasAttribute('data-entering')).toBe(false);
    expect(fold.dataset.open).toBe('true');
    view.rerender(<Fold open={false}><button>row</button></Fold>);
    expect(fold.isConnected).toBe(true);
    expect(fold.dataset.open).toBe('false');
    expect(fold.hasAttribute('inert')).toBe(true);
    expect(screen.queryByRole('button', {name: 'row'})).toBeNull();
    const exit = reduced ? motionDefaults.micro : motionDefaults.medium * .7;
    act(() => vi.advanceTimersByTime(exit - 1));
    expect(fold.isConnected).toBe(true);
    act(() => vi.advanceTimersByTime(1));
    expect(fold.isConnected).toBe(false);
  });

  it('reverses a fold in progress without restarting, and keeps a kept shelf hidden rather than removed', () => {
    reducedMotion(false); vi.useFakeTimers();
    const view = render(<Fold keepMounted open><button>card</button></Fold>);
    const fold = document.querySelector<HTMLElement>('.tablet-fold')!;
    const card = screen.getByRole('button', {name: 'card'});
    view.rerender(<Fold keepMounted open={false}><button>card</button></Fold>);
    act(() => vi.advanceTimersByTime(50));
    view.rerender(<Fold keepMounted open><button>card</button></Fold>);
    expect(fold.hasAttribute('data-entering')).toBe(false);
    expect(fold.dataset.open).toBe('true');
    expect(screen.getByRole('button', {name: 'card'})).toBe(card);
    view.rerender(<Fold keepMounted open={false}><button>card</button></Fold>);
    act(() => vi.advanceTimersByTime(motionDefaults.medium));
    expect(fold.hidden).toBe(true);
    expect(card.isConnected).toBe(true);
  });
});

describe('swipe review card', () => {
  type Recorded = {element: Element; frames: Keyframe[]; options: KeyframeAnimationOptions; listeners: Map<string, () => void>};
  function recordAnimations() {
    const calls: Recorded[] = [];
    vi.spyOn(HTMLElement.prototype, 'animate').mockImplementation(function (this: HTMLElement, frames, options) {
      const listeners = new Map<string, () => void>();
      calls.push({element: this, frames: frames as Keyframe[], options: options as KeyframeAnimationOptions, listeners});
      return {addEventListener: (type: string, listener: () => void) => listeners.set(type, listener), cancel: vi.fn()} as unknown as Animation;
    });
    return calls;
  }
  function card() {
    const body = document.createElement('div');
    body.className = 'review-body';
    body.innerHTML = '<div class="review-card" aria-label="검토 후보" style="transform: translate(120px, 0px) rotate(3deg)"><img alt="후보" src="x"/><span role="status">맞음</span></div>';
    document.body.append(body);
    return body.firstElementChild as HTMLElement;
  }
  if (typeof HTMLElement.prototype.animate !== 'function') HTMLElement.prototype.animate = (() => undefined) as unknown as HTMLElement['animate'];

  it.each([['accepted', 1], ['rejected', -1]] as const)('flies a %s card off to its side from where it was thrown, as an inert copy', (action, side) => {
    reducedMotion(false);
    const calls = recordAnimations();
    const element = card();
    flyOff(element, action);
    const ghost = element.parentElement!.querySelector<HTMLElement>('[data-review-ghost]')!;
    expect(ghost).not.toBeNull();
    expect(ghost.inert).toBe(true);
    expect(ghost.getAttribute('aria-hidden')).toBe('true');
    expect(ghost.querySelector('[role], [aria-label]')).toBeNull();
    const [flight] = calls;
    expect(flight!.element).toBe(ghost);
    const to = String(flight!.frames.at(-1)!.transform);
    expect(Math.sign(Number(/translate\((-?[\d.]+)px/.exec(to)![1]))).toBe(side);
    expect(flight!.frames.at(-1)!.opacity).toBe(0);
    expect(flight!.options.duration).toBe(motionDefaults.small);
    flight!.listeners.get('finish')!();
    expect(ghost.isConnected).toBe(false);
    expect(element.isConnected).toBe(true);
  });

  it('flies a skipped card up, and only fades it under reduced motion', () => {
    reducedMotion(false);
    let calls = recordAnimations();
    flyOff(card(), 'skipped');
    expect(String(calls[0]!.frames.at(-1)!.transform)).toMatch(/^translate\(0px, -/);
    vi.restoreAllMocks();
    reducedMotion(true);
    calls = recordAnimations();
    flyOff(card(), 'accepted');
    expect(calls[0]!.frames).toEqual([{opacity: 1}, {opacity: 0}]);
    expect(calls[0]!.options.duration).toBe(motionDefaults.micro);
  });

  it.each([false, true])('raises the next card from behind without sliding back from the thrown spot (reduced=%s)', reduced => {
    reducedMotion(reduced);
    const calls = recordAnimations();
    const element = card();
    riseIn(element);
    expect(element.style.transition).toBe('');
    expect(calls).toHaveLength(1);
    expect(calls[0]!.frames).toEqual(reduced ? [{opacity: 0}, {opacity: 1}] : [{opacity: 0, scale: .96}, {opacity: 1, scale: 1}]);
    expect(calls[0]!.options.duration).toBe(reduced ? motionDefaults.micro : motionDefaults.medium);
  });
});
