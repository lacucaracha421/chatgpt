import { describe, expect, it, vi } from 'vitest';
import { derivePerformerEntries, performerAge, performerDirections, performerMeasurements, performerSortLabel, sortPerformerEntries, type GridPerson, type PerformerEntry, type PerformerSort } from './performerGridModel';

const entry=(id:string,workCount:number,profile:GridPerson['profile']=null,latestDate:string|null=null):PerformerEntry=>({person:{id,displayName:id,profile},workCount,latestDate});
const ids=(entries:PerformerEntry[])=>entries.map(entry=>entry.person.id);
describe('performer grid ordering',()=>{
  it.each(['height','cup','age','recent'] as PerformerSort[])('keeps missing %s last in both directions and breaks equal values by work count',sort=>{
    const profile={heightCm:160,cup:'F',birthDate:'1998-05-02'};
    const rows=[entry('missing',90),entry('less',3,profile,'2026-10-14'),entry('more',8,profile,'2026-10-14'),entry('missing-less',1)];
    expect(ids(sortPerformerEntries(rows,sort,'asc'))).toEqual(['more','less','missing','missing-less']);
    expect(ids(sortPerformerEntries(rows,sort,'desc'))).toEqual(['more','less','missing','missing-less']);
  });
  it('orders each actual value, including younger dates and cup letters',()=>{
    const rows=[entry('older',5,{birthDate:'1990',heightCm:170,cup:'G'},'2024-01-01'),entry('younger',2,{birthDate:'2000-01-02',heightCm:160,cup:'F'},'2026-10-14')];
    expect(ids(sortPerformerEntries(rows,'age','asc'))).toEqual(['younger','older']);
    expect(ids(sortPerformerEntries(rows,'age','desc'))).toEqual(['older','younger']);
    expect(ids(sortPerformerEntries(rows,'height','desc'))).toEqual(['older','younger']);
    expect(ids(sortPerformerEntries(rows,'cup','asc'))).toEqual(['younger','older']);
    expect(ids(sortPerformerEntries(rows,'recent','desc'))).toEqual(['younger','older']);
    expect(ids(sortPerformerEntries(rows,'count','desc'))).toEqual(['older','younger']);
    expect(ids(sortPerformerEntries(rows,'name','desc'))).toEqual(['younger','older']);
  });
  it('counts each work once per performer and derives the latest release rather than addition date',()=>{
    const a={id:'a',displayName:'A'},b={id:'b',displayName:'B'};
    const works=[{id:'duo',releaseDate:'2026-10-14',people:[a,b,a]},{id:'solo',releaseDate:'2025-01-02',people:[a]},{id:'unknown',releaseDate:null,people:[b]}];
    expect(derivePerformerEntries(works,work=>work.people)).toEqual([{person:a,workCount:2,latestDate:'2026-10-14'},{person:b,workCount:2,latestDate:'2026-10-14'}]);
  });
  it('breaks equal displayed ages by work count rather than by birthday',()=>{
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026,9,28));
    try {
      const rows=[entry('later-birthday',2,{birthDate:'1998-09-01'}),entry('more-works',8,{birthDate:'1998-01-01'})];
      expect(ids(sortPerformerEntries(rows,'age','asc'))).toEqual(['more-works','later-birthday']);
      expect(ids(sortPerformerEntries(rows,'age','desc'))).toEqual(['more-works','later-birthday']);
    } finally {vi.useRealTimers();}
  });
});
describe('performer card values',()=>{
  const now=new Date(2026,9,28);
  it('uses full-date age, preserves birth-year precision and omits absent values',()=>{
    expect(performerAge({id:'a',profile:{birthDate:'1998-10-29'}},now)).toBe('만 27세');
    expect(performerAge({id:'a',profile:{birthDate:'1998-10-28'}},now)).toBe('만 28세');
    expect(performerAge({id:'a',profile:{birthDate:'1998'}},now)).toBe('1998년생');
    expect(performerAge({id:'a'},now)).toBe('');
    expect(performerMeasurements({id:'a',profile:{bandIn:35,waistIn:23,hipIn:34,cup:'F'}})).toEqual({bust:'B89 (F)',waist:'W58',hip:'H86'});
    expect(performerMeasurements({id:'a',profile:{cup:'F'}})).toEqual({bust:'F컵',waist:'',hip:''});
    expect(performerMeasurements({id:'a',profile:{waistIn:23}})).toEqual({bust:'',waist:'W58',hip:''});
    expect(performerSortLabel(entry('a',38,null,'2026-10-14'),'recent',now)).toBe('10.14');
  });
  it('puts the approved first direction on the left for every criterion',()=>{
    expect((['count','name','age','height','cup','recent'] as const).map(sort=>performerDirections(sort)[0].label)).toEqual(['많은순','가나다순','어린순','큰순','큰순','최신순']);
  });
});
