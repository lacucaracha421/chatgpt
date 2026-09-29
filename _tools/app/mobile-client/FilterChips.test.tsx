import {readFileSync} from 'node:fs';
import {cleanup, fireEvent, render, screen} from '@testing-library/react';
import {afterEach, expect, it, vi} from 'vitest';
import {FilterChips} from './FilterChips';
import {EMPTY_FILTERS} from './assetFilters';
afterEach(cleanup);
const css=readFileSync('mobile-client/library.css','utf8');

it('hides length while only images are chosen and clears a length that no longer applies',()=>{
  const onChange=vi.fn(),onOpen=vi.fn();
  const view=render(<FilterChips value={{...EMPTY_FILTERS,duration:'1m_5m'}} onChange={onChange} open="media" onOpen={onOpen}/>);
  fireEvent.click(screen.getByRole('radio',{name:'이미지'}));
  expect(onChange).toHaveBeenCalledWith({...EMPTY_FILTERS,media:'images',duration:'all'});
  view.rerender(<FilterChips value={{...EMPTY_FILTERS,media:'images'}} onChange={onChange} open={null} onOpen={onOpen}/>);
  expect(screen.queryByRole('button',{name:/길이/})).toBeNull();
  view.rerender(<FilterChips value={{...EMPTY_FILTERS,media:'videos'}} onChange={onChange} open={null} onOpen={onOpen}/>);
  expect((screen.getByRole('button',{name:/길이/}) as HTMLButtonElement).disabled).toBe(false);
});
it('marks selected chips and uses a transient pressed face without a focus residue',()=>{
  render(<FilterChips value={{...EMPTY_FILTERS,media:'images'}} applied={{...EMPTY_FILTERS,media:'images'}} onChange={()=>{}} open={null} onOpen={()=>{}}/>);
  expect(screen.getByRole('button',{name:'이미지'}).className).toContain('selected');
  expect(css).toContain('.filter-chip:active:not(:disabled) { background:var(--color-surface-pressed); }');
  expect(css).toContain('font-weight:600');
  expect(css).toContain('.filter-chip:focus:not(:focus-visible) { outline:none; }');
  expect(css).toContain('.ui-dialog:has(>.library-sheet) { animation:sheet-enter 140ms var(--ease-standard); }');
  expect(css).toContain('.filter-chips--toolbar .filter-chip--toolbar.selected');
});
