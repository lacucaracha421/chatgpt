import {act,cleanup,fireEvent,render,screen,waitFor} from '@testing-library/react';
import {afterEach,beforeEach,it,expect,vi} from 'vitest';
import {Notes,type MobileNote} from './Notes';
const mock=vi.hoisted(()=>({native:vi.fn()}));
vi.mock('./transport',()=>({native:mock.native,errorText:(e:Error)=>e.message}));
const note:MobileNote={id:'a'.repeat(32),title:'제목',body:'내용',pinned:false,deleted:false,createdAt:'2026-09-13',updatedAt:'2026-09-13',localRevision:1,pending:false,conflict:false};
beforeEach(()=>{mock.native.mockReset();mock.native.mockImplementation(async(op)=>op==='notesState'||op==='notesSync'?{unlocked:true,notes:[note]}:undefined);});
afterEach(cleanup);
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
