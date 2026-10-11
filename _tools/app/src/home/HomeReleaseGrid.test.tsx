import { render, screen, cleanup } from '@testing-library/react';
import { afterEach, expect, it } from 'vitest';
import { HomeReleaseGrid, releaseDisplayTitle } from './HomeReleaseGrid';

afterEach(cleanup);
it('omits repeated series/season labels after normalizing punctuation, case and spacing', () => {
  expect(releaseDisplayTitle('사이버펑크: 엣지러너 · 사이버펑크 엣지러너')).toBe('사이버펑크: 엣지러너');
  expect(releaseDisplayTitle('Cyberpunk: Edgerunners ·  CYBERPUNK   Edgerunners! ')).toBe('Cyberpunk: Edgerunners');
  expect(releaseDisplayTitle('애니 · 시즌 2')).toBe('애니 · 시즌 2');
  expect(releaseDisplayTitle('사이버펑크: 엣지러너 · 사이버펑크: 엣지러너 2')).toBe('사이버펑크: 엣지러너 2');
  expect(releaseDisplayTitle('작품 · 다른 이야기')).toBe('작품 · 다른 이야기');
  render(<HomeReleaseGrid today="2026-10-11" rows={[{ key: 'anime', name: '사이버펑크: 엣지러너 · 사이버펑크 엣지러너', date: null, detail: '애니', onOpen() {} }]} />);
  expect(screen.getByRole('button')).toHaveTextContent('사이버펑크: 엣지러너');
  expect(screen.getByRole('button')).not.toHaveTextContent(' · ');
});
