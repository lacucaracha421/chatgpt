import { Badge } from '../shared/ui/Badge';
import { ddayLabel, displayDate } from '../shared/displayDate';
import { daysAfter } from './homeModel';
import type { HomeReleaseCard } from './HomeAttention';

export function HomeReleaseGrid({ rows, today }: { rows: HomeReleaseCard[]; today: string }) {
  return <div className="home-release-grid">{rows.map(row => <button type="button" className="home-release-tile" key={row.key} onClick={row.onOpen}>
    <span className="home-release-tile__art">{row.cover}{row.fresh && <Badge className="home-release-tile__new" variant="accent">NEW</Badge>}</span>
    <span className="home-release-tile__when"><span>{[row.date ? displayDate(row.date, new Date(`${today}T12:00:00`)) : '', row.detail].filter(Boolean).join(' · ')}</span>
      {row.date && <Badge variant={row.date === today ? 'accent' : 'plain'}>{ddayLabel(daysAfter(row.date, today))}</Badge>}
    </span><b>{row.name}</b>
  </button>)}</div>;
}
