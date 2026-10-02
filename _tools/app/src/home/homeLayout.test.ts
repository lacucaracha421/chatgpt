import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
it('shares one-column tablet layout, quiet feedback and reduced motion without content entrance effects', () => {
  const css=readFileSync('src/home/homeAttention.css','utf8');
  expect(css).toContain('.home-attention-layout.is-tablet { grid-template-columns:minmax(0, 1fr); }');
  expect(css).toContain('140ms var(--ease-standard)'); expect(css).toContain('90ms var(--ease-standard)');
  expect(css).toContain('@media (prefers-reduced-motion:reduce)');
  expect(readFileSync('src/home/home.css','utf8')).not.toMatch(/animation:|translate/);
  expect(readFileSync('mobile-client/home.css','utf8')).not.toMatch(/animation:|translate/);
});
