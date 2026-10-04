import {cleanup,render} from '@testing-library/react';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {FolderShelf} from './FolderCards';

// A shelf that stays mounted while its folder changes (the Library subfolder strip, the
// character shelf) replays the PC shelf's first-batch entrance for each new place.
const animate=vi.fn(()=>({cancel:vi.fn()}));
beforeEach(()=>{
  vi.stubGlobal('ResizeObserver',class{observe(){}unobserve(){}disconnect(){}});
  vi.stubGlobal('CSS',{supports:()=>false});
  Object.defineProperty(HTMLElement.prototype,'animate',{configurable:true,value:animate});
});
afterEach(()=>{cleanup();animate.mockClear();vi.unstubAllGlobals();delete (HTMLElement.prototype as Partial<HTMLElement>).animate;});
const shelf=(place:string,names:string[])=><FolderShelf label="폴더" appearanceKey="classification-folder-shelf" appearancePlace={place} cards={names.map(name=><article key={name} className="folder-shelf__card">{name}</article>)}/>;

it('replays the card entrance in a new place only',()=>{
  const view=render(shelf('a',['one','two']));
  expect(animate).toHaveBeenCalledTimes(2);
  expect(animate.mock.calls[0]).toEqual([[{transform:'translateY(8px) scale(.98)'},{transform:'none'}],expect.objectContaining({duration:560,delay:0})]);
  view.rerender(shelf('a',['one','two','three']));
  expect(animate).toHaveBeenCalledTimes(2);
  view.rerender(shelf('b',['four']));
  expect(animate).toHaveBeenCalledTimes(3);
});
