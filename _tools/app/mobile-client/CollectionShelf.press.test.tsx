import {cleanup,render} from '@testing-library/react';
import {readFileSync} from 'node:fs';
import {afterEach,expect,it,vi} from 'vitest';
vi.mock('./collectionArtwork',()=>({useCoverUrl:()=>null}));
import {ShelfTile} from './CollectionShelf';
const css=readFileSync('mobile-client/collectionShelf.css','utf8');
afterEach(cleanup);
it('marks shelf covers for containment in both picked and unpicked states',()=>{
  const item={id:'work',name:'작품',type:'game' as const};
  const view=render(<ShelfTile item={item} revision="1" active privacy={false} picked={false} onTap={()=>{}}/>);
  expect(view.container.querySelector('button')?.classList.contains('collection-cover-cell')).toBe(true);
  view.rerender(<ShelfTile item={item} revision="1" active privacy={false} picked onTap={()=>{}}/>);
  expect(view.container.querySelector('button.collection-cover-cell[aria-selected="true"]')).toBeTruthy();
});
it('clips the cell and keeps the picked transform centred with no translation',()=>{
  expect(css).toContain('.collection-list__cell:has(.collection-cover-cell) { overflow:clip; }');
  expect(css).toContain('.collection-cover-cell .collection-card__light { overflow:hidden; }');
  const rule=css.match(/\.mobile-collections \.collection-cover-cell \.collection-light-case\[data-front\] \.cs-box \{([^}]+)\}/)![1];
  expect(rule).toContain('transform-origin:center');expect(rule).toContain('transform:scale(.98)');
  expect(rule).not.toContain('translate');expect(rule).toContain('var(--motion-small)');
  expect(css).toContain('@media (prefers-reduced-motion:reduce)');
  expect(css).toContain('.collection-cover-cell .collection-light-case[data-front] .cs-box { transition:none; }');
});
