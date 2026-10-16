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

it('lays the PC Home out as the calendar and tools on the left and the card place and attention on the right', () => {
  const css = readFileSync('src/home/home.css', 'utf8');
  expect(css).toMatch(/\.home-pc-layout\s*\{[^}]*min\(400px/);
  const view = readFileSync('src/home/HomeView.tsx', 'utf8');
  for (const piece of ['<HomeCalendar', '<HomeTransfer', '<HomeQuickMemo', '<HomeLinkVault', '<HomeDailyCard', '<HomeToday']) expect(view).toContain(piece);
  // 지금 하는 중, 오늘의 그림 and 1년 전 오늘 left the PC Home.
  for (const gone of ['HomePlaying', 'HomeDay', 'useHomeMedia', 'useHomeRevisitDay']) expect(view).not.toContain(gone);
  const tools = readFileSync('src/home/homeTools.css', 'utf8');
  expect(tools).not.toMatch(/animation:|translate|border-(left|top|bottom)-color|box-shadow:\s*inset/);
  const calendar = readFileSync('src/home/homeCalendar.css', 'utf8');
  expect(calendar).not.toMatch(/border-left:/);
  // New activity may ease into its reserved space; release covers and day cells stay put.
  expect(calendar).not.toMatch(/\.home-cal__(?:day|item)\s*\{[^}]*animation:/);
});
