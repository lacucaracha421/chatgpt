import {act,cleanup,fireEvent,render,screen,waitFor} from '@testing-library/react';
import {afterEach,beforeEach,it,expect,vi} from 'vitest';
import {Notes,type MobileNote} from './Notes';
const mock=vi.hoisted(()=>({native:vi.fn()}));
vi.mock('./transport',()=>({native:mock.native,errorText:(e:Error)=>e.message}));
const note:MobileNote={id:'a'.repeat(32),title:'제목',body:'내용',pinned:false,deleted:false,createdAt:'2026-09-13',updatedAt:'2026-09-13',localRevision:1,pending:false,conflict:false};
beforeEach(()=>{mock.native.mockReset();mock.native.mockImplementation(async(op)=>op==='notesState'||op==='notesSync'?{unlocked:true,notes:[note]}:undefined);});
afterEach(()=>{cleanup();vi.useRealTimers();vi.restoreAllMocks();vi.unstubAllGlobals();});
it('keeps typing made during a save and writes it against the acknowledged local revision',async()=>{
 let finish!:(value:MobileNote)=>void;
 mock.native.mockImplementation(async(op,p)=>{
  if(op==='notesSave'){if(p.body==='first')return new Promise(resolve=>{finish=resolve;});return {...note,...p,localRevision:3,pending:true};}
  return {unlocked:true,notes:[note]};
 });
 render(<Notes active backRef={{current:null}}/>);fireEvent.click(await screen.findByRole('button',{name:/제목/}));
 fireEvent.change(await screen.findByRole('textbox',{name:'메모 내용'}),{target:{value:'first'}});
 await waitFor(()=>expect(finish).toBeTypeOf('function'));
 fireEvent.change(await screen.findByRole('textbox',{name:'메모 내용'}),{target:{value:'second'}});
 await act(async()=>finish({...note,body:'first',localRevision:2,pending:true}));
 await waitFor(()=>expect(mock.native.mock.calls.some(([op,p])=>op==='notesSave'&&p.body==='second'&&p.expectedRevision===2)).toBe(true));
 expect(localStorage.getItem('notes')).toBeNull();
});
it('retains a failed draft and retries it explicitly',async()=>{
 mock.native.mockImplementation(async(op)=>{if(op==='notesSave')throw new Error('offline');return {unlocked:true,notes:[note]};});
 render(<Notes active backRef={{current:null}}/>);fireEvent.click(await screen.findByRole('button',{name:/제목/}));
 fireEvent.change(await screen.findByRole('textbox',{name:'메모 내용'}),{target:{value:'남겨 둘 내용'}});
 await screen.findByText('offline');expect((screen.getByRole('textbox',{name:'메모 내용'}) as HTMLTextAreaElement).value).toBe('남겨 둘 내용');
 const before=mock.native.mock.calls.filter(([op])=>op==='notesSave').length;fireEvent.click(screen.getByRole('button',{name:'다시 시도'}));
 await waitFor(()=>expect(mock.native.mock.calls.filter(([op])=>op==='notesSave').length).toBeGreaterThan(before));
});

const pinned:MobileNote={...note,id:'b'.repeat(32),title:'고정한 메모',pinned:true};
const trashed:MobileNote={...note,id:'c'.repeat(32),title:'지운 메모',deleted:true};
it('groups pinned notes, keeps the trash behind a small link and returns with Back',async()=>{
 mock.native.mockImplementation(async(op)=>op==='notesState'||op==='notesSync'?{unlocked:true,notes:[note,pinned,trashed]}:undefined);
 const backRef:{current:(()=>boolean)|null}={current:null};
 render(<Notes active backRef={backRef}/>);await screen.findByText('고정한 메모');
 expect(screen.getByRole('heading',{name:'고정됨'})).toBeTruthy();expect(screen.getByRole('heading',{name:'최근'})).toBeTruthy();
 expect(screen.queryByText('지운 메모')).toBeNull();expect(screen.queryByRole('button',{name:'휴지통',exact:true})).toBeNull();
 fireEvent.click(screen.getByRole('button',{name:'휴지통 1'}));
 await screen.findByText('지운 메모');expect(screen.queryByText('고정한 메모')).toBeNull();expect(screen.queryByRole('button',{name:'새 메모'})).toBeNull();
 act(()=>{expect(backRef.current?.()).toBe(true);});
 await screen.findByText('고정한 메모');expect(backRef.current?.()).toBe(false);
});
it('creates a note from the floating button and moves an open note to the trash',async()=>{
 const saves:Partial<MobileNote>[]=[];
 mock.native.mockImplementation(async(op,p)=>{if(op==='notesSave'){saves.push(p);return {...note,...p,localRevision:2,pending:true};}return {unlocked:true,notes:[note]};});
 render(<Notes active backRef={{current:null}}/>);await screen.findByText('제목');
 fireEvent.click(screen.getByRole('button',{name:'새 메모'}));
 expect(await screen.findByRole('textbox',{name:'메모 제목'})).toBeTruthy();fireEvent.click(screen.getByRole('button',{name:'메모 목록'}));
 await screen.findByRole('button',{name:'새 메모'});
 fireEvent.click(screen.getByText('제목'));fireEvent.click(await screen.findByRole('button',{name:'고정'}));
 expect(screen.getByRole('button',{name:'고정 해제'})).toBeTruthy();
 fireEvent.click(screen.getByRole('button',{name:'메모 휴지통으로'}));
 await waitFor(()=>expect(saves.some(s=>s.id===note.id&&s.deleted===true&&s.pinned===true)).toBe(true));
 await screen.findByRole('button',{name:'새 메모'});
});
it('shows a trashed note read-only with a restore action',async()=>{
 mock.native.mockImplementation(async(op,p)=>op==='notesSave'?{...trashed,...p,localRevision:2,pending:true}:{unlocked:true,notes:[note,trashed]});
 render(<Notes active backRef={{current:null}}/>);fireEvent.click(await screen.findByRole('button',{name:'휴지통 1'}));
 fireEvent.click(await screen.findByText('지운 메모'));
 expect(await screen.findByText('휴지통에 있는 메모입니다.')).toBeTruthy();
 expect((screen.getByRole('textbox',{name:'메모 내용'}) as HTMLTextAreaElement).readOnly).toBe(true);
 fireEvent.click(screen.getByRole('button',{name:'복원'}));
 await waitFor(()=>expect(screen.queryByText('휴지통에 있는 메모입니다.')).toBeNull());
});

it('fits the editor above the visual keyboard, follows viewport panning, and restores on close',async()=>{
 const viewport=Object.assign(new EventTarget(),{height:1280,offsetTop:0,scale:1});
 vi.stubGlobal('visualViewport',viewport);vi.stubGlobal('innerHeight',1280);
 vi.spyOn(HTMLElement.prototype,'getBoundingClientRect').mockReturnValue({top:64,bottom:1200,left:0,right:800,width:800,height:1136,x:0,y:64,toJSON:()=>({})});
 render(<Notes active backRef={{current:null}}/>);fireEvent.click(await screen.findByText('제목'));
 const body=await screen.findByRole('textbox',{name:'메모 내용'}),section=screen.getByRole('region',{name:'메모'});
 expect(section.style.maxHeight).toBe('1216px');
 act(()=>body.focus());
 act(()=>{viewport.height=800;viewport.dispatchEvent(new Event('resize'));});
 expect(section.style.maxHeight).toBe('736px');expect(document.activeElement).toBe(body);
 // A resized layout must not have the same keyboard height subtracted again.
 vi.stubGlobal('innerHeight',800);fireEvent(window,new Event('resize'));
 expect(section.style.maxHeight).toBe('736px');
 act(()=>{viewport.offsetTop=100;viewport.dispatchEvent(new Event('scroll'));});
 expect(section.style.maxHeight).toBe('836px');
 act(()=>{viewport.height=1280;viewport.offsetTop=0;viewport.dispatchEvent(new Event('resize'));});
 expect(section.style.maxHeight).toBe('1216px');
 fireEvent.click(screen.getByRole('button',{name:'메모 목록'}));await screen.findByRole('button',{name:'새 메모'});
 expect(section.style.maxHeight).toBe('');
});

it('cleans up viewport listeners on tab switches and does not treat pinch zoom as a keyboard',async()=>{
 const viewport=Object.assign(new EventTarget(),{height:700,offsetTop:0,scale:1});
 vi.stubGlobal('visualViewport',viewport);
 const removed=vi.spyOn(viewport,'removeEventListener'),backRef={current:null};
 const view=render(<Notes active backRef={backRef}/>);fireEvent.click(await screen.findByText('제목'));
 await screen.findByRole('textbox',{name:'메모 내용'});const section=screen.getByRole('region',{name:'메모'});
 expect(section.style.maxHeight).toBe('700px');
 act(()=>{viewport.scale=2;viewport.dispatchEvent(new Event('resize'));});expect(section.style.maxHeight).toBe('');
 view.rerender(<Notes active={false} backRef={backRef}/>);
 expect(removed).toHaveBeenCalledWith('resize',expect.any(Function));expect(removed).toHaveBeenCalledWith('scroll',expect.any(Function));
 view.rerender(<Notes active backRef={backRef}/>);view.unmount();expect(removed).toHaveBeenCalledTimes(4);
});

it('backs pending sync off from two seconds to one minute and stops timers when hidden',async()=>{
 vi.useFakeTimers();let visibility:DocumentVisibilityState='visible';
 vi.spyOn(document,'visibilityState','get').mockImplementation(()=>visibility);
 mock.native.mockResolvedValue({unlocked:true,notes:[{...note,pending:true}]});
 render(<Notes active backRef={{current:null}}/>);await act(async()=>{});
 const syncs=()=>mock.native.mock.calls.filter(([op])=>op==='notesSync').length;
 expect(syncs()).toBe(0);
 for(const [index,delay] of [2000,4000,8000,16000,32000,60000].entries()){
  await act(()=>vi.advanceTimersByTimeAsync(delay-1));expect(syncs()).toBe(index);
  await act(()=>vi.advanceTimersByTimeAsync(1));expect(syncs()).toBe(index+1);
 }
 visibility='hidden';act(()=>document.dispatchEvent(new Event('visibilitychange')));
 expect(vi.getTimerCount()).toBe(0);await act(()=>vi.advanceTimersByTimeAsync(120000));expect(syncs()).toBe(6);
});
