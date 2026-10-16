import {readFileSync} from 'node:fs';
import {expect, it} from 'vitest';

it('keeps the tablet Home touch targets at 44px', () => {
  const css = readFileSync('mobile-client/homeTablet/homeTablet.css', 'utf8');
  expect(css).toMatch(/\.home-tablet-week__nav \.ui-icon-button \{ min-width:44px; min-height:44px; \}/);
  expect(css).toMatch(/\.home-cal__payment\.ui-button[^{]*\{ min-height:44px; \}/);
  expect(css).toMatch(/\.home-tab-link \{[^}]*min-height:48px/);
  expect(css).toMatch(/\.home-tab-sent li \{[^}]*min-height:44px/);
});
