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

it('lets the 지금 하는 중 shelf end at its content and scroll through the shared hidden-scrollbar shelf', () => {
  const css = readFileSync('src/home/home.css', 'utf8');
  // The media column stacks its sections with the normal gap; nothing pushes 2주 안에 발매 to the bottom.
  expect(css).not.toMatch(/\.home-media-column\s*\{[^}]*space-between/);
  // No native scrollbar of its own: the shared shelf track scrolls (wheel, drag, arrows) with its bar hidden.
  const shelf = css.match(/\.home-playing\s*\{([^}]*)\}/)![1];
  expect(shelf).not.toMatch(/overflow|scrollbar|(^|[;\s])(min-)?height:/);
  expect(css).toMatch(/\.home-playing__track\s*\{[^}]*flex:none/);
  expect(readFileSync('src/home/HomePlayingShelf.tsx', 'utf8')).toContain('<ShelfScroller');
  const shared = readFileSync('src/styles/controls.css', 'utf8');
  expect(shared).toMatch(/\.home-shelf__track\s*\{[^}]*scrollbar-width: none/);
  expect(shared).toContain('.home-shelf__track::-webkit-scrollbar { display: none; }');
});
