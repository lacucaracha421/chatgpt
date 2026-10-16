import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';

it('keeps Home free of content entrance effects and reduced motion honoured', () => {
  expect(readFileSync('src/home/homeAttention.css', 'utf8')).toContain('@media (prefers-reduced-motion:reduce)');
  expect(readFileSync('src/home/home.css', 'utf8')).not.toMatch(/animation:|translate/);
  expect(readFileSync('mobile-client/home.css', 'utf8')).not.toMatch(/animation:|translate/);
});

it('keeps the PC Home tools and calendar free of entrance effects and edge-stripe marks', () => {
  const tools = readFileSync('src/home/homeTools.css', 'utf8');
  expect(tools).not.toMatch(/animation:|translate|border-(left|top|bottom)-color|box-shadow:\s*inset/);
  const calendar = readFileSync('src/home/homeCalendar.css', 'utf8');
  expect(calendar).not.toMatch(/border-left:/);
  // New activity may ease into its reserved space; release covers and day cells stay put.
  expect(calendar).not.toMatch(/\.home-cal__(?:day|item)\s*\{[^}]*animation:/);
});
