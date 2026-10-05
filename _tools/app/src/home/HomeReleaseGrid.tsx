import { Badge } from '../shared/ui/Badge';
import { DDay } from '../shared/ui/DDay';
import { displayDate } from '../shared/displayDate';
import { daysAfter } from './homeModel';
import type { HomeReleaseCard } from './HomeAttention';

export function HomeReleaseGrid({ rows, today }: { rows: HomeReleaseCard[]; today: string }) {
  return <div className="home-release-grid">{rows.map(row => <button type="button" className="home-release-tile" key={row.key} onClick={row.onOpen}>
    <span className="home-release-tile__art">{row.cover}{row.fresh && <Badge className="home-release-tile__new" variant="accent">NEW</Badge>}</span>
    <span className="home-release-tile__when"><span>{[row.date ? displayDate(row.date, new Date(`${today}T12:00:00`)) : '', row.detail].filter(Boolean).join(' · ')}</span>
      {row.date && <DDay days={daysAfter(row.date, today)} />}
    </span><b>{row.name}</b>
  </button>)}</div>;
}
