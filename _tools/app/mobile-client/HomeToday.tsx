import {ExclamationTriangleIcon, RectangleStackIcon} from '@heroicons/react/24/outline';
import {HomeToday} from '../src/home/HomeAttention';
import type {AttentionRow} from '../src/home/homeAttentionModel';
import {displayCount} from '../src/shared/displayDate';
import {Badge} from './ui';

/** Tablet attention rows: the shared list with square badges and counted units, without entrance animation. */
export function TabletHomeToday({rows,onOpen}:{rows:AttentionRow[];onOpen(row:AttentionRow):void}) {
  return <HomeToday rows={rows} onOpen={onOpen} animate={false}
    mark={row=><Badge icon={row.problem?ExclamationTriangleIcon:RectangleStackIcon} variant={row.problem?'danger':'plain'} aria-label={row.problem?'확인 필요':'할 것'} aria-hidden="true"/>}
    formatValue={row=>row.noteId&&row.value&&/^\d+$/.test(row.value)?displayCount(Number(row.value),'개'):row.value}/>;
}
