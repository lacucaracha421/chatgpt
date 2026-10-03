import { describe, expect, it } from 'vitest';
import type { CollectionSummary, ReleaseWishlistItem } from '../library/types';
import { cloudLine, daysAfter, newlyReleasedRows, releaseRows, upcomingRows } from './homeModel';
const title = (id: string, date: string, extra: Partial<ReleaseWishlistItem> = {}) => ({ id, title: id, kind:'game', provider:'igdb', date, precision:'exact', platforms:[], unread:[], muted:false, released:false, ...extra }) as ReleaseWishlistItem;
describe('Home release sources', () => {
  it('includes existing unread NEW notices and dated releases without a new read', () => {
    const wishlist = [title('new', '2026-10-01', { released:true, unread:[{id:'event',itemId:'new',readAt:null,kind:'released',detectedAt:'2026-10-01',currentValue:'2026-10-01',previousValue:null}] }), title('past','2026-09-30'), title('future','2026-10-03'), title('muted','2026-10-01',{muted:true})];
    const rows = newlyReleasedRows([], new Map(), new Map(), wishlist, '2026-10-02');
    expect(rows.map(r => r.name)).toEqual(['new','past']);
    expect(rows[0]?.caption.kind).toBe('new'); expect(rows[1]?.caption.kind).toBe('info');
    expect(releaseRows([],new Map(),new Map(),wishlist,'2026-10-02').map(r=>r.name)).toEqual(['new']);
  });
  it('uses exact release dates of locally known works, omitting AV and imprecise dates', () => {
    const works = [{id:'g',name:'Game',type:'game',releaseDate:'2026-10-01'}, {id:'av',name:'AV',type:'av',releaseDate:'2026-10-01'}, {id:'year',name:'Year',type:'game',releaseDate:'2026'}] as CollectionSummary[];
    expect(newlyReleasedRows(works,new Map(),new Map(),[],'2026-10-02').map(r=>r.name)).toEqual(['Game']);
  });
  it('sorts upcoming exact dates, with D-n measured across month and year ends', () => {
    expect(upcomingRows([],new Map(),new Map(),[title('later','2026-11-01'),title('first','2026-10-31'),title('imprecise','2026-11-01',{precision:'month'})],'2026-10-30').map(r=>r.name)).toEqual(['first','later']);
    expect(daysAfter('2026-11-01','2026-10-30')).toBe(2);
    expect(daysAfter('2027-01-01','2026-12-31')).toBe(1);
    expect(daysAfter('2028-03-01','2028-02-28')).toBe(2);
  });
});

it('shows the hold when no sync problems are reported', () => {
  expect(cloudLine({ syncHeld: true } as import('../library/types').CloudBackfillProgress, 0)).toEqual({ tone: 'idle', text: '받기만 · 송신 보류' });
});

it("shows receive problems ahead of a hold", () => {
  expect(cloudLine({ syncHeld: true } as import('../library/types').CloudBackfillProgress, 2)).toEqual({ tone: 'off', text: '문제 2개' });
});
