import { Badge } from '../shared/ui/Badge';
import { DDay } from '../shared/ui/DDay';
import { displayDate } from '../shared/displayDate';
import { daysAfter } from './homeModel';
import type { HomeReleaseCard } from './HomeAttention';

export function releaseDisplayTitle(title: string): string {
  const normalize = (value: string) => value.trim().toLowerCase().replace(/\p{P}/gu, '').replace(/\s+/gu, ' ').trim();
  // A later part that repeats or extends the one before it ("엣지러너" · "엣지러너 2") replaces it.
  const kept: string[] = [];
  for (const part of title.split(' · ')) {
    const previous = kept[kept.length - 1];
    if (previous !== undefined && normalize(part) === normalize(previous)) continue;
    if (previous !== undefined && normalize(part).startsWith(normalize(previous))) kept[kept.length - 1] = part;
    else kept.push(part);
  }
  return kept.join(' · ');
}

export function HomeReleaseGrid({ rows, today }: { rows: HomeReleaseCard[]; today: string }) {
  return <div className="home-release-grid">{rows.map(row => <button type="button" className="home-release-tile" key={row.key} onClick={row.onOpen}>
    <span className="home-release-tile__art">{row.cover}{row.fresh && <Badge className="home-release-tile__new" variant="accent">NEW</Badge>}</span>
    <span className="home-release-tile__when"><span>{[row.date ? displayDate(row.date, new Date(`${today}T12:00:00`)) : '', row.detail].filter(Boolean).join(' · ')}</span>
      {row.date && <DDay days={daysAfter(row.date, today)} />}
    </span><b>{releaseDisplayTitle(row.name)}</b>
  </button>)}</div>;
}
