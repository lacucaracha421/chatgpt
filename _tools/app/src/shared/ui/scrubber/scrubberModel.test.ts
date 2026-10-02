import {describe,expect,it} from 'vitest';
import {buildScrubberModel,generateScrubberTicks,koreanInitial,scrubberIndexAt,scrubberLabelAt,clampScrubberTag,thinScrubberLabels} from './scrubberModel';

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

  it('thins year labels to 44px apart and always keeps the first and last',()=>{
    for (const width of [320,600,984,1400]) for (const count of [3,8,20,27]) {
      const marks=Array.from({length:count},(_,k)=>({key:k,label:String(2026-k),x:(k/(count-1))*width}));
      const kept=thinScrubberLabels(marks);
      expect(kept[0]).toBe(marks[0]);expect(kept[kept.length-1]).toBe(marks[count-1]);
      kept.slice(1).forEach((mark,i)=>expect(mark.x-kept[i].x).toBeGreaterThanOrEqual(44));
    }
  });
  it('prefers years divisible by five over others when labels compete',()=>{
    const marks=[2027,2026,2025,2024,2023].map((year,k)=>({key:k,label:String(year),x:k*30}));
    expect(thinScrubberLabels(marks).map(mark=>mark.label)).toEqual(['2027','2025','2023']);
  });
  it('keeps the floating label inside the bar',()=>{
    expect(clampScrubberTag(0,400,100)).toBe(50);expect(clampScrubberTag(400,400,100)).toBe(350);expect(clampScrubberTag(200,400,100)).toBe(200);
  });
});

it('uses local month and year for timestamps while preserving date-only buckets', () => {
  const timestamps = ['2026-01-01T00:30:00+14:00', '2025-12-31T23:30:00-12:00', '2026-03-01T00:30:00+14:00'];
  for (const timestamp of timestamps) {
    const date = new Date(timestamp);
    const localDate = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-15`;
    const model = buildScrubberModel({ kind: 'date', values: [timestamp, localDate] });
    expect(model.labelAt(0)).toBe(`${date.getFullYear()}년 ${date.getMonth() + 1}월`);
    expect(model.ticks).toHaveLength(1);
  }
  expect(scrubberLabelAt({ kind: 'date', values: ['2026-01-01'] }, 0)).toBe('2026년 1월');
  expect(scrubberLabelAt({ kind: 'date', values: ['2026-03'] }, 0)).toBe('2026년 3월');
});
