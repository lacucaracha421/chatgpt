import {readFileSync} from 'node:fs';
import {expect, it} from 'vitest';
import {filmstripControlsOffset} from './CenteredFilmstrip';

it.each([124, 132])('positions controls at the painted strip top for height=%s', height => {
  for (const grown of [false, true]) {
    const stripTop = 12 + (height + 16) * (grown ? 1 : .5);
    expect(16 + filmstripControlsOffset(height, grown, true)).toBe(stripTop);
    expect(filmstripControlsOffset(height, grown, false)).toBe(0);
  }
});

it.each([
  ['PC', '../../assets/asset-viewer.css', '.asset-viewer .video-player__controls'],
  ['tablet', '../../../mobile-client/Viewer.css', '.viewer-surface .video-player__controls'],
])('%s moves only the control bar with a 200ms transform and disables it for reduced motion', (_client, file, selector) => {
  const css = readFileSync(new URL(file, import.meta.url), 'utf8');
  const style = document.createElement('style');
  style.textContent = css;
  document.head.append(style);
  try {
    const rules = Array.from(style.sheet!.cssRules);
    const controls = rules.find(rule => (rule as CSSStyleRule).selectorText === selector) as CSSStyleRule;
    expect(controls.style.getPropertyValue('transform')).toBe('translateY(calc(-1 * var(--viewer-controls-offset, 0px)))');
    expect(controls.style.getPropertyValue('transition')).toContain('transform 200ms var(--ease-sheet)');
    expect(Number(controls.style.getPropertyValue('z-index'))).toBeGreaterThan(4);
    const reduced = rules.find(rule => (rule as CSSMediaRule).conditionText === '(prefers-reduced-motion: reduce)') as CSSMediaRule;
    expect(Array.from(reduced.cssRules).some(rule => {
      const reducedRule = rule as CSSStyleRule;
      return reducedRule.selectorText.includes(selector) && reducedRule.style.getPropertyValue('transition') === 'none';
    })).toBe(true);
    const stripRules = rules.filter(rule => (rule as CSSStyleRule).selectorText?.includes('filmstrip')) as CSSStyleRule[];
    expect(stripRules.some(rule => /is-video|stage--video/.test(rule.selectorText))).toBe(false);
    expect(stripRules.some(rule => rule.style.getPropertyValue('transform'))).toBe(false);
  } finally {style.remove();}
});
