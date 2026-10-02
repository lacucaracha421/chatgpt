import {cleanup, fireEvent, render, screen} from '@testing-library/react';
import {useRef} from 'react';
import {afterEach, expect, it, vi} from 'vitest';
import {useScrubberList} from './useScrubberList';

afterEach(()=>{cleanup(); vi.restoreAllMocks();});
it('seeks the unpainted cell shells and reports the first item in the current row',()=>{
  function Fixture() {
    const root=useRef<HTMLDivElement>(null);
    const {onSeek,indexAtScroll}=useScrubberList(root,'.cell');
    return <><div ref={root} aria-label="list">
      {[0,0,200,200,400].map((offset,index)=><div key={index} className="cell" data-offset={offset}/>)}</div>
      <button onClick={()=>onSeek(3)}>seek</button><button onClick={()=>{document.querySelector('output')!.textContent=String(indexAtScroll());}}>measure</button><output/></>;
  }
  render(<Fixture/>);
  const root=screen.getByLabelText('list'); root.scrollTop=80;
  vi.spyOn(root,'getBoundingClientRect').mockReturnValue({top:50} as DOMRect);
  root.querySelectorAll<HTMLElement>('.cell').forEach(cell=>{
    vi.spyOn(cell,'getBoundingClientRect').mockImplementation(()=>({top:50+Number(cell.dataset.offset)-root.scrollTop,bottom:250+Number(cell.dataset.offset)-root.scrollTop} as DOMRect));
  });
  fireEvent.click(screen.getByText('seek')); expect(root.scrollTop).toBe(200);
  fireEvent.click(screen.getByText('measure')); expect(document.querySelector('output')!.textContent).toBe('2');
});
