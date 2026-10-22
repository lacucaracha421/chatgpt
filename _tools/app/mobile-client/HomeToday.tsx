import {HomeToday} from '../src/home/HomeAttention';
import type {AttentionRow} from '../src/home/homeAttentionModel';
import {displayCount} from '../src/shared/displayDate';

/** Tablet attention rows: the shared list and mark (□ / !) with counted units, without entrance animation. */
export function TabletHomeToday({rows,onOpen}:{rows:AttentionRow[];onOpen(row:AttentionRow):void}) {
  return <HomeToday rows={rows} onOpen={onOpen} animate={false}
    formatValue={row=>row.noteId&&row.value&&/^\d+$/.test(row.value)?displayCount(Number(row.value),'개'):row.value}/>;
}
