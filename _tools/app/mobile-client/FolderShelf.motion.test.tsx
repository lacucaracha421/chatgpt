import {cleanup,render} from '@testing-library/react';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {FolderShelf} from './FolderCards';

// A shelf with an entrance plays the PC shelf's first-batch entrance once per visit; later cards
// (another folder's, more of the same) appear without it.
const animate=vi.fn(()=>({cancel:vi.fn()}));
beforeEach(()=>{
  vi.stubGlobal('ResizeObserver',class{observe(){}unobserve(){}disconnect(){}});
  vi.stubGlobal('CSS',{supports:()=>false});
  Object.defineProperty(HTMLElement.prototype,'animate',{configurable:true,value:animate});
});
afterEach(()=>{cleanup();animate.mockClear();vi.unstubAllGlobals();delete (HTMLElement.prototype as Partial<HTMLElement>).animate;});
const shelf=(names:string[])=><FolderShelf label="폴더" appearanceKey="classification-folder-shelf" cards={names.map(name=><article key={name} className="folder-shelf__card">{name}</article>)}/>;

it('plays the card entrance once per visit',()=>{
  const view=render(shelf(['one','two']));
  expect(animate).toHaveBeenCalledTimes(2);
  expect(animate.mock.calls[0]).toEqual([[{transform:'translateY(8px) scale(.98)'},{transform:'none'}],expect.objectContaining({duration:560,delay:0})]);
  view.rerender(shelf(['one','two','three']));
  view.rerender(shelf(['four']));
  expect(animate).toHaveBeenCalledTimes(2);
});
