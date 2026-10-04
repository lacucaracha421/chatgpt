import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, it } from 'vitest';
const desktop = ['src/assets/assets.css', 'src/styles/shared-hover.css']
  .map(path => readFileSync(resolve(path), 'utf8')).join('\n');
const tablet = readFileSync(resolve('mobile-client/mobile.css'), 'utf8');
it('uses brief opacity reveals and a spatial panel transition, with instant reduced motion', () => {
  expect(desktop).toMatch(/\.asset-gallery__hover-control\s*\{[^}]*opacity: 0;[^}]*opacity 90ms var\(--ease-standard\)/);
  expect(desktop).toMatch(/\.classification-sidebar__badge\s*\{[^}]*opacity: 0;[^}]*opacity 90ms var\(--ease-standard\)/);
  expect(desktop).toContain('.classification-sidebar__tree-row[aria-selected="true"] .classification-sidebar__badge { opacity: 1; }');
  expect(desktop).toMatch(/\.asset-inspector--docked\s*\{[^}]*transform 200ms var\(--ease-standard\), opacity 200ms var\(--ease-standard\)/);
  expect(desktop).toMatch(/@media \(prefers-reduced-motion: reduce\)\s*\{[^}]*\.asset-inspector--docked[^}]*transition: none;/);
  const countRules = [...tablet.matchAll(/[^{}]*\.gallery-date-heading__count[^{}]*\{([^}]*)\}/g)];
  expect(countRules.length).toBeGreaterThan(0);
  for (const [, declarations] of countRules) {
    expect(declarations).not.toMatch(/(?:visibility\s*:\s*hidden|display\s*:\s*none)/);
    for (const [, opacity] of declarations.matchAll(/opacity\s*:\s*([^;]+)/g)) expect(opacity.trim()).toBe('1');
  }
  expect(tablet).toContain('@media (prefers-reduced-motion:reduce) { .gallery-date-heading__count { transition:none; } }');
});
