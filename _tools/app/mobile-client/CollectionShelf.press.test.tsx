import {act,cleanup,render} from '@testing-library/react';
import {readFileSync} from 'node:fs';
import {afterEach,expect,it,vi} from 'vitest';
vi.mock('./collectionArtwork',()=>({useCoverUrl:()=>null}));
import {ShelfTile} from './CollectionShelf';
const css=readFileSync('mobile-client/collectionShelf.css','utf8');
afterEach(()=>{cleanup();vi.useRealTimers();vi.unstubAllGlobals();});
it('marks shelf covers for containment in both picked and unpicked states',()=>{
  const item={id:'work',name:'작품',type:'game' as const};
  const view=render(<ShelfTile item={item} revision="1" active privacy={false} picked={false} onTap={()=>{}}/>);
  expect(view.container.querySelector('button')?.classList.contains('collection-cover-cell')).toBe(true);
  view.rerender(<ShelfTile item={item} revision="1" active privacy={false} picked onTap={()=>{}}/>);
  expect(view.container.querySelector('button.collection-cover-cell[aria-selected="true"]')).toBeTruthy();
});
it('fits the full front and spine lead inside the cell and turns around a fixed hinge',()=>{
  expect(css).toContain('.collection-list__cell:has(.collection-cover-cell) { overflow:visible; }');
  expect(css).toContain('.collection-cover-cell .collection-card__light { overflow:visible; }');
  expect(css).toContain('calc(var(--cell-width) / (var(--case-ratio) + .048))');
  expect(css).toContain('calc((var(--cell-width) - 4.8px) / var(--case-ratio))');
  expect(css).toContain('transform-origin:0 100%; transition:transform 360ms var(--ease-sheet)');
  const rule=css.match(/\.mobile-collections \.collection-cover-cell \.collection-light-case\[data-front\] \.cs-box \{([^}]+)\}/)![1];
  expect(rule).toContain('transform:rotateX(0deg) rotateY(0deg)');
  expect(rule).not.toMatch(/translate|scale|transform-origin/);
  expect(css).toContain('@media (prefers-reduced-motion:reduce)');
  expect(css).toContain('.collection-cover-cell .collection-light-case .cs-box { transition:none; }');
});

it.each(['game','manga','movie','av'] as const)('keeps the picked %s cell above a later settling neighbour with tablet styles',type=>{
  vi.useFakeTimers();
  vi.stubGlobal('matchMedia',()=>({matches:false}));
  const style=document.createElement('style');
  style.textContent=readFileSync('src/collections/CollectionBrowser.css','utf8')+
    readFileSync('src/collections/case/LightCase.css','utf8').replace(/^@import[^\n]*\n/,'')+
    readFileSync('src/collections/collectionShelfRules.css','utf8')+css;
  document.head.append(style);
  try {
    const draw=(picked:number)=><div className="mobile-collections"><div className="collection-list collection-list--shelf">{[0,1].map(index=>
      <div className="collection-list__cell" key={index}><ShelfTile item={{id:String(index),name:'작품',type}} revision="1" active privacy={false} picked={picked===index} onTap={()=>{}}/></div>)}</div></div>;
    const view=render(draw(1));
    const box=view.container.querySelector('.cs-box');
    view.rerender(draw(0));
    const cells=view.container.querySelectorAll<HTMLElement>('.collection-list__cell');
    expect(cells[1].querySelector('[data-settling]')).not.toBeNull();
    expect(getComputedStyle(cells[0]).zIndex).toBe('3');
    expect(getComputedStyle(cells[1]).zIndex).toBe('2');
    expect(getComputedStyle(cells[0]).overflow).toBe('visible');
    expect(getComputedStyle(cells[0].querySelector('.cs-box')!).transform).toBe('rotateX(0deg) rotateY(0deg)');
    expect(getComputedStyle(cells[0].querySelector('.cs-box')!).transformOrigin).toBe('0 100%');
    act(()=>vi.advanceTimersByTime(420));
    expect(getComputedStyle(cells[1]).zIndex).toBe('1');
    expect(getComputedStyle(cells[0]).zIndex).toBe('3');
    expect(view.container.querySelector('.cs-box')).toBe(box);
  } finally {style.remove();}
});
