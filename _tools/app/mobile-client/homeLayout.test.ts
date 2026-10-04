import {readFileSync} from 'node:fs';
import {expect, it} from 'vitest';

it('places media on the left and attention above the image on the right in landscape; portrait follows DOM order with horizontal shelves', () => {
  const css = readFileSync('mobile-client/home.css', 'utf8');
  expect(css).toContain('.home-tablet-media-column { grid-column:1;');
  expect(css).toContain('.home-tablet-day-column { grid-column:2; }');
  expect(css).toContain('@media (orientation:portrait), (max-width:700px)');
  expect(css).toContain('.home-tablet-layout { display:flex; flex-direction:column;');
  expect(css).toContain('.home-tablet-media-column, .home-tablet-day-column { display:contents; }');
  for (const [index, section] of ['today', 'playing', 'releases', 'day'].entries()) expect(css).toContain(`.home-tablet-${section} { order:${index}; }`);
  expect(css).toContain('grid-auto-flow:column;');
  expect(css).toContain('min-height:44px; min-width:44px;');
  const shared = readFileSync('src/home/home.css', 'utf8');
  expect(shared).toMatch(/home-daily__image[^}]*object-fit:contain/);
  expect(shared).toMatch(/home-daily__backdrop[^}]*blur/);
});
