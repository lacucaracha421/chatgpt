import {describe,expect,it} from 'vitest';
import {buildScrubberModel,generateScrubberTicks,koreanInitial,scrubberIndexAt,scrubberLabelAt} from './scrubberModel';

describe('scrubber model',()=>{
  it('maps the scrubber edges to the first and last item',()=>{
    expect(scrubberIndexAt(-.2,5)).toBe(0);
    expect(scrubberIndexAt(0,5)).toBe(0);
    expect(scrubberIndexAt(1,5)).toBe(4);
    expect(scrubberIndexAt(1.2,5)).toBe(4);
  });

  it('generates year majors and month minors for dates',()=>{
    const sort={kind:'date' as const,values:['2025-01-02','2025-03-11','2025-03-20','2026-01-01']};
    const ticks=generateScrubberTicks(sort,sort.values.length);
    expect(ticks.filter(tick=>tick.major).map(tick=>tick.label)).toEqual(['2025','2026']);
    expect(ticks.filter(tick=>!tick.major).map(tick=>tick.index)).toEqual([1]);
    expect(scrubberLabelAt(sort,1)).toBe('2025년 3월');
  });

  it('groups Korean double initials with their base and includes Latin and other majors',()=>{
    expect(koreanInitial('까')).toBe('ㄱ');
    expect(koreanInitial('따')).toBe('ㄷ');
    expect(koreanInitial('Zebra')).toBe('Z');
    expect(koreanInitial('7 items')).toBe('#');
    const sort={kind:'name' as const,values:['가방','까치','나무','따뜻한','Apple','banana','7 items']};
    expect(generateScrubberTicks(sort,sort.values.length).map(tick=>tick.label)).toEqual(['ㄱ','ㄴ','ㄷ','A','B','#']);
  });

  it('uses ten percent majors without a semantic label as fallback',()=>{
    const model=buildScrubberModel({kind:'fallback'},101);
    expect(model.ticks).toHaveLength(11);
    expect(model.ticks.map(tick=>tick.position)).toEqual([0,.1,.2,.3,.4,.5,.6,.7,.8,.9,1]);
    expect(model.labelAt(50)).toBeNull();
  });
});
