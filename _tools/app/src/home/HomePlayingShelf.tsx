import { useState, type ReactNode } from 'react';
import { HomeSection } from './HomeAttention';
import { RecordStars } from '../collections/work/WorkRecord';
import { ShelfScroller } from '../shared/ui/ShelfScroller';

export type HomePlayingWork = { id: string; name: string; platform: string; score: number | null; case(selected: boolean): ReactNode };

/** Both clients own the artwork transport; the shelf and its interactions are shared. */
export function HomePlayingShelf({ works, onOpen, onAll }: { works: HomePlayingWork[]; onOpen(id: string): void; onAll?: () => void }) {
  const [hovered, setHovered] = useState<string | null>(null);
  const [focused, setFocused] = useState<string | null>(null);
  if (!works.length) return null;
  return <HomeSection title={`지금 하는 중 · ${works.length}`} onOpen={onAll}>
    <div className="home-playing"><ShelfScroller previousLabel="이전 지금 하는 중" nextLabel="다음 지금 하는 중"><div className="home-playing__track">
      <span className="home-playing__plank" aria-hidden="true" />
      {works.map(work => <button type="button" className="home-playing__work" key={work.id} aria-label={`${work.name} 열기`}
        onMouseEnter={() => setHovered(work.id)} onMouseLeave={() => setHovered(null)} onFocus={() => setFocused(work.id)} onBlur={() => setFocused(null)} onClick={() => onOpen(work.id)}>
        {work.case(hovered === work.id || focused === work.id)}
        <span className="home-playing__meta"><b>{work.name}</b><span>{work.platform}</span><RecordStars score={work.score} /></span>
      </button>)}
    </div></ShelfScroller></div>
  </HomeSection>;
}
