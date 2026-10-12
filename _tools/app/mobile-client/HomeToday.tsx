import {ExclamationTriangleIcon, RectangleStackIcon} from '@heroicons/react/24/outline';
import {HomeSection} from '../src/home/HomeAttention';
import type {AttentionRow} from '../src/home/homeAttentionModel';
import {displayCount} from '../src/shared/displayDate';
import {Badge, DDay} from './ui';

/** Tablet attention rows keep the shared section, badge and date rules. */
export function HomeToday({rows,onOpen}:{rows:AttentionRow[];onOpen(row:AttentionRow):void}) {
  return <HomeSection title="오늘 할 것" count={rows.length}>{rows.map(row=><div key={row.key}>
    <button type="button" className="home-attention-row" data-problem={row.problem||undefined} disabled={row.disabled} onClick={()=>onOpen(row)}>
      <Badge icon={row.problem?ExclamationTriangleIcon:RectangleStackIcon} variant={row.problem?'danger':'plain'} aria-label={row.problem?'확인 필요':'할 것'} aria-hidden="true"/>
      <span className="home-attention-copy"><span>{row.label}</span>{row.secondary&&<small>{row.secondary}</small>}</span>
      {row.days!==undefined?<DDay days={row.days}/>:row.value&&<span className="home-attention-value numeric">{row.noteId&&/^\d+$/.test(row.value)?displayCount(Number(row.value),'개'):row.value}</span>}
    </button>
  </div>)}</HomeSection>;
}
