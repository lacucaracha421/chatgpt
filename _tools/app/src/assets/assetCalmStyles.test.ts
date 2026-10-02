import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, it } from 'vitest';
const desktop = readFileSync(resolve('src/styles/global.css'), 'utf8');
const tablet = readFileSync(resolve('mobile-client/mobile.css'), 'utf8');
it('uses brief opacity reveals and a spatial panel transition, with instant reduced motion', () => {
  expect(desktop).toMatch(/\.asset-gallery__hover-control\s*\{[^}]*opacity: 0;[^}]*opacity 90ms var\(--ease-standard\)/);
  expect(desktop).toMatch(/\.classification-sidebar__badge\s*\{[^}]*opacity: 0;[^}]*opacity 90ms var\(--ease-standard\)/);
  expect(desktop).toContain('.classification-sidebar__tree-row[aria-selected="true"] .classification-sidebar__badge { opacity: 1; }');
  expect(desktop).toMatch(/\.asset-inspector--docked\s*\{[^}]*transform 200ms var\(--ease-standard\), opacity 200ms var\(--ease-standard\)/);
  expect(desktop).toMatch(/@media \(prefers-reduced-motion: reduce\)\s*\{[^}]*\.asset-inspector--docked[^}]*transition: none;/);
  expect(tablet).toMatch(/\.gallery-date-heading__count\s*\{[^}]*opacity:0;[^}]*opacity 90ms var\(--ease-standard\)/);
  expect(tablet).toContain('@media (prefers-reduced-motion:reduce) { .gallery-date-heading__count { transition:none; } }');
});
