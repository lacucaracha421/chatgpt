import {readFileSync} from 'node:fs';
import {expect, it} from 'vitest';

it('stacks the PC parts in one column, pairs card with 오늘 할 것 and memo with links, and keeps touch targets at 44px', () => {
  const css = readFileSync('mobile-client/homeTablet/homeTablet.css', 'utf8');
  expect(css).toContain('.home-tablet-layout { min-height:100%; display:flex; flex-direction:column;');
  expect(css).toContain('.home-tablet-pair { display:grid; grid-template-columns:repeat(2,minmax(0,1fr));');
  // Two halves always, also in portrait (user 2026-10-16).
  expect(css).not.toContain('is-single');
  expect(css).not.toContain('max-width:700px');
  expect(css).toContain('.home-tablet-week { touch-action:pan-y; }');
  expect(css).toMatch(/\.home-tablet-week__nav \.ui-icon-button \{ min-width:44px; min-height:44px; \}/);
  expect(css).toMatch(/\.home-cal__payment\.ui-button[^{]*\{ min-height:44px; \}/);
  expect(css).toMatch(/\.home-tab-link \{[^}]*min-height:48px/);
  expect(css).toMatch(/\.home-tab-sent li \{[^}]*min-height:44px/);
  const base = readFileSync('mobile-client/home.css', 'utf8');
  expect(base).toContain('min-height:44px; min-width:44px;');
  // The removed sections leave no layout rules behind.
  for (const gone of ['home-tablet-media-column', 'home-tablet-day-column', 'home-tablet-playing', 'home-tablet-releases', 'home-tablet-day ']) expect(base).not.toContain(gone);
  const shared = readFileSync('src/home/home.css', 'utf8');
  expect(shared).toMatch(/home-daily__image[^}]*object-fit:contain/);
});
