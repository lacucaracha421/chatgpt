import {cleanup, fireEvent, render, screen} from '@testing-library/react';
import {afterEach, expect, it, vi} from 'vitest';
import {FilterChips} from './FilterChips';
import {EMPTY_FILTERS} from './assetFilters';
afterEach(cleanup);

it('disables length while only images are chosen and clears a length that no longer applies',()=>{
  const onChange=vi.fn(),onOpen=vi.fn();
  const view=render(<FilterChips value={{...EMPTY_FILTERS,duration:'1m_5m'}} onChange={onChange} open="media" onOpen={onOpen}/>);
  fireEvent.click(screen.getByRole('radio',{name:'이미지'}));
  expect(onChange).toHaveBeenCalledWith({...EMPTY_FILTERS,media:'images',duration:'all'});
  view.rerender(<FilterChips value={{...EMPTY_FILTERS,media:'images'}} onChange={onChange} open={null} onOpen={onOpen}/>);
  const length=screen.getByRole('button',{name:'길이 (이미지에는 적용되지 않음)'}) as HTMLButtonElement;
  expect(length.disabled).toBe(true);
  view.rerender(<FilterChips value={{...EMPTY_FILTERS,media:'videos'}} onChange={onChange} open={null} onOpen={onOpen}/>);
  expect((screen.getByRole('button',{name:/길이/}) as HTMLButtonElement).disabled).toBe(false);
});
