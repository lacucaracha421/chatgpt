import {act,cleanup,fireEvent,render,screen,waitFor} from '@testing-library/react';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {CatalogReader} from './CatalogReader';
import type {CatalogReaderManifest} from './catalogModel';

const mocks=vi.hoisted(()=>({ticket:vi.fn(),decode:vi.fn()}));
vi.mock('./catalogMedia',()=>({catalogImageTicket:mocks.ticket}));
vi.mock('./media',()=>({decodeImage:mocks.decode}));
const manifest:CatalogReaderManifest={provider:'kHentai',providerWorkId:'42',publicationRevision:'p1',manifestExpiresAt:1800000000,
  pages:Array.from({length:40},(_,index)=>({index,url:`https://example.invalid/${index}`,name:`${index}`,width:600,height:900,expiresAt:1800000000}))};
const requested=()=>mocks.ticket.mock.calls.map(([page])=>page.index as number);
const visiblePages=()=>[...document.querySelectorAll<HTMLElement>('.catalog-reader-leaf')].filter(node=>node.style.display!=='none').map(node=>Number(node.querySelector('[data-page]')?.getAttribute('data-page')));
async function open(){
  render(<CatalogReader manifest={manifest} title="만화" onClose={()=>{}} onRefresh={()=>{}} refreshing={false}/>);
  await screen.findByRole('img',{name:'1페이지'});
  return screen.getByRole('slider',{name:'페이지 이동'});
}
beforeEach(()=>{localStorage.clear();
  vi.stubGlobal('innerWidth',800);vi.stubGlobal('innerHeight',1280);
  mocks.ticket.mockReset();mocks.decode.mockReset();
  mocks.ticket.mockImplementation(async page=>({url:`https://app.lakomics.local/media-cache/page-${page.index}`}));
  mocks.decode.mockResolvedValue({naturalWidth:600,naturalHeight:900});
});
afterEach(()=>{cleanup();vi.useRealTimers();vi.unstubAllGlobals();});

it('previews 25 / 40 throughout a long drag, then loads only the destination neighborhood and waits for decoding',async()=>{
  let finish!:()=>void;
  mocks.decode.mockImplementation((url:string)=>url.endsWith('-24')?new Promise(resolve=>{finish=()=>resolve({naturalWidth:600,naturalHeight:900});}):Promise.resolve({naturalWidth:600,naturalHeight:900}));
  const slider=await open();expect(requested()).toEqual([0,1,2]);
  fireEvent.pointerDown(slider,{pointerId:1});
  fireEvent.change(slider,{target:{value:'10'}});fireEvent.change(slider,{target:{value:'25'}});
  expect(screen.getByText('25 / 40')).toBeTruthy();expect(slider.getAttribute('aria-valuetext')).toBe('25 / 40페이지');
  vi.useFakeTimers();act(()=>vi.advanceTimersByTime(5000));vi.useRealTimers();
  expect(document.querySelector('.catalog-reader')?.classList.contains('chrome-visible')).toBe(true);
  expect(requested()).toEqual([0,1,2]);expect(visiblePages()).toEqual([0]);
  fireEvent.pointerUp(slider,{pointerId:1});
  await waitFor(()=>expect(finish).toBeTypeOf('function'));
  expect(screen.getByRole('status').textContent).toBe('25페이지 준비 중…');
  // The requested page number shows at once and never flips back to the page still on screen.
  expect(screen.getAllByText('25 / 40')).toHaveLength(2);expect(screen.queryByText('1 / 40')).toBeNull();
  expect(requested()).toEqual([0,1,2,22,23,24,25,26]);expect(visiblePages()).toEqual([0]);
  await act(async()=>finish());
  await waitFor(()=>expect(visiblePages()).toEqual([24]));
  expect(screen.getAllByText('25 / 40')).toHaveLength(2);
  expect(document.querySelectorAll('.catalog-reader-leaf')).toHaveLength(5);
});

it('cancels scrubbing without loading pages and can jump to both endpoints',async()=>{
  const slider=await open();
  fireEvent.pointerDown(slider,{pointerId:1});fireEvent.change(slider,{target:{value:'25'}});fireEvent.pointerCancel(slider,{pointerId:1});
  expect((slider as HTMLInputElement).value).toBe('1');expect(requested()).toEqual([0,1,2]);
  fireEvent.pointerDown(slider,{pointerId:2});fireEvent.change(slider,{target:{value:'40'}});fireEvent.pointerUp(slider,{pointerId:2});
  await waitFor(()=>expect(visiblePages()).toEqual([39]));
  expect(requested()).toEqual([0,1,2,37,38,39]);
  expect((screen.getByRole('button',{name:'다음 페이지'}) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.change(slider,{target:{value:'1'}});
  await waitFor(()=>expect(visiblePages()).toEqual([0]));
  expect((screen.getByRole('button',{name:'이전 페이지'}) as HTMLButtonElement).disabled).toBe(true);
});

it('leaves range arrow keys to the native control and commits keyboard or accessibility changes',async()=>{
  const slider=await open();
  expect(fireEvent.keyDown(slider,{key:'ArrowLeft'})).toBe(true);
  expect(fireEvent.keyDown(slider,{key:'ArrowRight'})).toBe(true);
  expect(requested()).toEqual([0,1,2]);
  fireEvent.change(slider,{target:{value:'25'}});
  await waitFor(()=>expect(visiblePages()).toEqual([24]));
});

it('jumps to the spread containing the selected page in landscape',async()=>{
  vi.stubGlobal('innerWidth',1280);vi.stubGlobal('innerHeight',800);
  const slider=await open();fireEvent.change(slider,{target:{value:'25'}});
  await waitFor(()=>expect(visiblePages()).toEqual([23,24]));
  expect(screen.getAllByText('24–25 / 40')).toHaveLength(2);
  expect(requested().every(index=>index<=2||(index>=21&&index<=26))).toBe(true);
});

it('keeps counting from the requested page when next is tapped again while a page loads',async()=>{
  const pending:Array<()=>void>=[];
  mocks.decode.mockImplementation((url:string)=>/-(1|2|3)$/.test(url)&&!url.endsWith('-1')||url.endsWith('-1')?new Promise(resolve=>{pending.push(()=>resolve({naturalWidth:600,naturalHeight:900}));}):Promise.resolve({naturalWidth:600,naturalHeight:900}));
  await open();
  fireEvent.click(screen.getByRole('button',{name:'다음 페이지'}));
  expect(screen.getAllByText('2 / 40')).toHaveLength(2);
  fireEvent.click(screen.getByRole('button',{name:'다음 페이지'}));
  expect(screen.getAllByText('3 / 40')).toHaveLength(2);
  expect(screen.queryByText('1 / 40')).toBeNull();
});


it('blocks opening a reader in privacy mode without page tickets or image sources',()=>{
 localStorage.setItem('lakomics.mobile.privacyMode','1');const close=vi.fn();
 render(<CatalogReader manifest={manifest} title="만화" onClose={close} onRefresh={()=>{}} refreshing={false}/>);
 expect(document.querySelector('img[src]')).toBeNull();expect(mocks.ticket).not.toHaveBeenCalled();
 expect(screen.getByLabelText('비공개 모드')).toBeTruthy();expect(close).toHaveBeenCalledOnce();
});
it('closes the open reader and aborts page work when privacy turns on',async()=>{
 const close=vi.fn();render(<CatalogReader manifest={manifest} title="만화" onClose={close} onRefresh={()=>{}} refreshing={false}/>);
 await screen.findByRole('img',{name:'1페이지'});
 const signal=mocks.ticket.mock.calls[0][1] as AbortSignal;
 act(()=>{localStorage.setItem('lakomics.mobile.privacyMode','1');window.dispatchEvent(new Event('lakomics-privacy-mode'));});
 expect(document.querySelector('img[src]')).toBeNull();expect(screen.queryByRole('dialog')).toBeNull();
 expect(signal.aborted).toBe(true);expect(close).toHaveBeenCalledOnce();
});
it('turns pages with side taps (left = next, right = previous) and shows the bars from the middle',async()=>{
  await open();
  const stage=screen.getByLabelText('만화 페이지');
  vi.spyOn(stage,'getBoundingClientRect').mockReturnValue({left:0,top:0,right:1000,bottom:1280,width:1000,height:1280,x:0,y:0,toJSON:()=>({})});
  const tap=(x:number)=>{fireEvent.pointerDown(stage,{pointerId:7,clientX:x,clientY:600,button:0});fireEvent.pointerUp(stage,{pointerId:7,clientX:x,clientY:600});};
  tap(100);
  await screen.findByRole('img',{name:'2페이지'});
  await waitFor(()=>expect(visiblePages()).toEqual([1]));
  expect(document.querySelector('.catalog-reader')?.classList.contains('chrome-visible')).toBe(false);
  tap(900);
  await waitFor(()=>expect(visiblePages()).toEqual([0]));
  tap(500);
  expect(document.querySelector('.catalog-reader')?.classList.contains('chrome-visible')).toBe(true);
  expect(visiblePages()).toEqual([0]);
});
