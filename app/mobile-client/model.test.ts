import {describe, expect, it} from 'vitest';
import {imageNeighbours, justifiedRows, mapBounded, normalizePage, pagePath, RequestGate, fitTransform} from './model';
import type {Asset} from './types';
const assets: Asset[] = [0.4,1.5,1,3,0.6,2,1.4].map((ratio,index) => ({id:String(index),kind:'image',ratio}));
describe('gallery geometry', () => {
  for (const width of [360,800,1280]) for (const height of [150,220,290]) {
    it(`preserves all intrinsic ratios and order within ${width}px at ${height}px density`, () => {
      const rows = justifiedRows(assets,width,height);
      expect(rows.flatMap(row => row.items.map(item => item.asset.id))).toEqual(assets.map(asset => asset.id));
      for (const row of rows) {
        expect(row.items.reduce((sum,item) => sum+item.width,0)+10*(row.items.length-1)).toBeLessThanOrEqual(width+.001);
        for (const item of row.items) expect(item.width/row.height).toBeCloseTo(item.asset.ratio!);
      }
      expect(rows.at(-1)!.height).toBeLessThanOrEqual(height);
    });
  }
  it('handles missing metadata and panorama without cropping', () => {
    const result=justifiedRows([{id:'a',kind:'image'},{id:'b',kind:'image',width:10000,height:100}],800,220);
    expect(result[0].items[0].width/result[0].height).toBe(1);
    expect(result[0].items[1].width/result[0].height).toBe(100);
    expect(justifiedRows(assets,0,220)).toEqual([]);
  });
});
describe('request ordering and bounded media', () => {
  it('clamps pan when a zoomed portrait is reduced to fitted size', () => {
    expect(fitTransform(1,2000,-2000,800,1000,.75)).toEqual({scale:1,x:0,y:-0});
    const reduced=fitTransform(1.1,2000,2000,800,1000,.75);
    expect(reduced.x).toBeCloseTo(12.5); expect(reduced.y).toBeCloseTo(50);
  });
  it('a superseded request cannot commit even when its network response arrives later', () => {
    const gate=new RequestGate(), first=gate.begin(), next=gate.begin();
    expect(first.signal.aborted).toBe(true); expect(gate.current(first.id)).toBe(false); expect(gate.current(next.id)).toBe(true);
    gate.cancel(); expect(gate.current(next.id)).toBe(false);
  });
  it('honours server cursors rather than guessing from count and removes duplicate IDs', () => {
    expect(normalizePage({items:[assets[0],assets[0]],has_more:true,next_cursor:null})).toEqual({items:[assets[0]],has_more:false,next_cursor:null});
    expect(pagePath({tab:'home',title:'최근 저장'},null)).toBe('/v1/library/assets?limit=40');
    expect(pagePath({tab:'library',title:'test',classification:'a&b'},'opaque=')).toContain('classification_id=a%26b');
  });
  it('preloads only immediate images, never videos or pending captures', () => {
    expect(imageNeighbours([assets[0],assets[1],{...assets[2],kind:'video'},assets[3]],1)).toEqual([assets[0]]);
    expect(imageNeighbours([{...assets[0],pending:true},assets[1],assets[2]],1)).toEqual([assets[2]]);
  });
  it('limits concurrent work and preserves input ordering', async () => {
    let active=0, peak=0;
    const output=await mapBounded([1,2,3,4,5,6],2,async value=>{active++; peak=Math.max(peak,active); await new Promise(resolve=>setTimeout(resolve,1)); active--; return value*2;});
    expect(peak).toBe(2); expect(output).toEqual([2,4,6,8,10,12]);
  });
});
