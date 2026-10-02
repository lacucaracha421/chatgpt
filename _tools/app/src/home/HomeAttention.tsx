import { useEffect, useLayoutEffect, useState, type ReactNode } from 'react';
import { SectionLabel } from '../shared/ui/SectionLabel';
import { Badge } from '../shared/ui/Badge';
import { ddayLabel, displayDate } from '../shared/displayDate';
import type { AttentionRow } from './homeAttention';
import { daysAfter } from './homeModel';
import './homeAttention.css';

type Item = { key: string; content: ReactNode };
/** Retiring rows keep their space until the 140 ms collapse finishes. Initial content is immediate. */
export function HomePresence({ items }: { items: Item[] }) {
  const [shown, setShown] = useState(() => items.map(i => ({ ...i, visible: true })));
  const [reduce, setReduce] = useState(() => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false);
  useEffect(() => {
    const media = window.matchMedia?.('(prefers-reduced-motion: reduce)');
    const update = () => setReduce(media?.matches ?? false);
    media?.addEventListener?.('change', update);
    return () => media?.removeEventListener?.('change', update);
  }, []);
  useLayoutEffect(() => {
    if (reduce) { setShown(items.map(i => ({ ...i, visible: true }))); return; }
    setShown(previous => {
      const current = items.map(i => ({ ...i, visible: previous.some(p => p.key === i.key && p.visible) }));
      for (let index = 0; index < previous.length; index++) {
        const old = previous[index]!;
        if (!items.some(i => i.key === old.key)) current.splice(index, 0, { ...old, visible: false });
      }
      return current;
    });
    const expand = window.setTimeout(() => setShown(previous => previous.map(i => items.some(next => next.key === i.key) ? { ...i, visible: true } : i)), 16);
    const retire = window.setTimeout(() => setShown(previous => previous.filter(i => items.some(next => next.key === i.key))), 156);
    return () => { clearTimeout(expand); clearTimeout(retire); };
  }, [items, reduce]);
  return <>{shown.map(i => <div className="home-presence" key={i.key} data-visible={i.visible} inert={!i.visible} aria-hidden={!i.visible}><div>{i.content}</div></div>)}</>;
}
export function HomeSection({ title, onOpen, children }: { title: string; onOpen?: () => void; children: ReactNode }) {
  return <section className="home-attention-section" aria-label={title}><SectionLabel title={title} onOpen={onOpen} /><div>{children}</div></section>;
}
export function HomeToday({ rows, onOpen, loading }: { rows: AttentionRow[]; onOpen(row: AttentionRow): void; loading?: ReactNode }) {
  const items: Item[] = rows.map(row => ({ key: row.key, content: <button type="button" className="home-attention-row" data-problem={row.problem || undefined} disabled={row.disabled} onClick={() => onOpen(row)}><span className="home-attention-mark" aria-hidden="true">{row.problem ? '!' : row.days !== undefined || row.noteId ? '○' : '□'}</span><span className="home-attention-copy"><span>{row.label}</span>{row.secondary && <small>{row.secondary}</small>}</span>{row.days !== undefined ? <Badge>{ddayLabel(row.days)}</Badge> : row.value && <span className="home-attention-value numeric">{row.value}</span>}</button> }));
  if (!rows.length) items.push({ key: 'empty', content: loading ?? <p className="home-attention-empty">오늘 할 것이 없습니다</p> });
  return <HomeSection title={`오늘 할 것 · ${rows.length}`}><HomePresence items={items} /></HomeSection>;
}
export type HomeReleaseCard = { key: string; name: string; date: string | null; detail?: string; fresh?: boolean; cover?: ReactNode; onOpen(): void };
export function HomeReleaseList({ rows, today }: { rows: HomeReleaseCard[]; today: string }) {
  return <HomePresence items={rows.map(row => ({ key: row.key, content: <button type="button" className="home-arrival-row" onClick={row.onOpen}>{row.cover && <span className="home-arrival-cover">{row.cover}</span>}<span className="home-attention-copy"><span>{row.name}</span><small>{[row.date ? displayDate(row.date, new Date(`${today}T12:00:00`)) : '', row.detail].filter(Boolean).join(' · ')}</small></span>{row.fresh ? <Badge variant="accent">NEW</Badge> : row.date && <Badge>{ddayLabel(daysAfter(row.date, today))}</Badge>}</button> }))} />;
}
export function HomeAttentionLayout({ today, right, tablet = false }: { today: ReactNode; right: ReactNode; tablet?: boolean }) {
  return <div className={`home-attention-layout${tablet ? ' is-tablet' : ''}`}><div className="home-attention-left">{today}</div><div className="home-attention-right">{right}</div></div>;
}
