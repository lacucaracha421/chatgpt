import {act,cleanup,fireEvent,render,screen,waitFor,within} from '@testing-library/react';
import {afterEach,beforeEach,it,expect,vi} from 'vitest';
import {Notes,type MobileNote} from './Notes';
const mock=vi.hoisted(()=>({native:vi.fn()}));
vi.mock('./transport',()=>({native:mock.native,errorText:(e:Error)=>e.message}));
const note:MobileNote={id:'a'.repeat(32),title:'제목',body:'내용',pinned:false,deleted:false,createdAt:'2026-09-13',updatedAt:'2026-09-13',localRevision:1,pending:false,conflict:false};
const saves=()=>mock.native.mock.calls.filter(([op])=>op==='notesSave').map(([,p])=>p);
const state=(notes:MobileNote[])=>async(op:string,p:Record<string,unknown>)=>op==='notesSave'?{createdAt:'2026-09-14',updatedAt:'2026-09-14',...notes.find(n=>n.id===p.id),...p,localRevision:Number(p.expectedRevision)+1,pending:true}:{unlocked:true,notes};
beforeEach(()=>{mock.native.mockReset();mock.native.mockImplementation(state([note]));});
afterEach(()=>{cleanup();vi.useRealTimers();vi.restoreAllMocks();vi.unstubAllGlobals();});
async function openNote(title:string){fireEvent.click(await screen.findByText(title));}
async function openTrash(){fireEvent.click(await screen.findByRole('button',{name:'메모 목록 더보기'}));fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button',{name:/^휴지통/}));}
const rendered=(text:string)=>screen.findByText(text,{selector:'.notes-rendered p'});
async function editBody(){fireEvent.click(await rendered('내용'));return await screen.findByRole('textbox',{name:'메모 내용'});}

it('shows text notes rendered, edits the source on tap and returns to the rendered view when leaving the text',async()=>{
 mock.native.mockImplementation(state([{...note,body:'# 제목줄\n- [ ] 우유\n\n내용'}]));
 render(<Notes active backRef={{current:null}}/>);await openNote('제목');
 expect(await screen.findByRole('heading',{name:'제목줄'})).toBeTruthy();
 expect(screen.queryByRole('textbox',{name:'메모 내용'})).toBeNull();
 expect(screen.queryByRole('button',{name:/^(보기|편집)$/})).toBeNull();
 expect(screen.getByRole('button',{name:'마크다운 도움말'})).toBeTruthy();
 // A rendered task checkbox rewrites its line.
 fireEvent.click(screen.getByRole('checkbox'));
 await waitFor(()=>expect(saves().some(s=>String(s.body).includes('- [x] 우유'))).toBe(true));
 fireEvent.click(await rendered('내용'));
 const area=await screen.findByRole('textbox',{name:'메모 내용'});
 // Tapping the rest of the note (here its title) leaves the source view.
 fireEvent.blur(area,{relatedTarget:screen.getByRole('textbox',{name:'메모 제목'})});
 await waitFor(()=>expect(screen.queryByRole('textbox',{name:'메모 내용'})).toBeNull());
});
it('keeps typing made during a save and writes it against the acknowledged local revision',async()=>{
 let finish!:(value:MobileNote)=>void;
 mock.native.mockImplementation(async(op,p)=>{
  if(op==='notesSave'){if(p.body==='first')return new Promise(resolve=>{finish=resolve;});return {...note,...p,localRevision:3,pending:true};}
  return {unlocked:true,notes:[note]};
 });
 render(<Notes active backRef={{current:null}}/>);await openNote('제목');
 fireEvent.change(await editBody(),{target:{value:'first'}});
 await waitFor(()=>expect(finish).toBeTypeOf('function'));
 fireEvent.change(screen.getByRole('textbox',{name:'메모 내용'}),{target:{value:'second'}});
 await act(async()=>finish({...note,body:'first',localRevision:2,pending:true}));
 await waitFor(()=>expect(saves().some(p=>p.body==='second'&&p.expectedRevision===2)).toBe(true));
 expect(saves()[0]).toMatchObject({id:note.id,expectedRevision:1,type:'text',body:'first'});
 expect(localStorage.getItem('notes')).toBeNull();
});
it('retains a failed draft and retries it explicitly',async()=>{
 mock.native.mockImplementation(async(op)=>{if(op==='notesSave')throw new Error('offline');return {unlocked:true,notes:[note]};});
 render(<Notes active backRef={{current:null}}/>);await openNote('제목');
 fireEvent.change(await editBody(),{target:{value:'남겨 둘 내용'}});
 await screen.findByText('offline');
 const before=saves().length;fireEvent.click(screen.getByRole('button',{name:'다시 시도'}));
 await waitFor(()=>expect(saves().length).toBeGreaterThan(before));
 expect(saves().at(-1)?.body).toBe('남겨 둘 내용');
});

const pinned:MobileNote={...note,id:'b'.repeat(32),title:'고정한 메모',pinned:true};
const trashed:MobileNote={...note,id:'c'.repeat(32),title:'지운 메모',deleted:true};
it('groups pinned notes, keeps the trash behind a small link and returns with Back',async()=>{
 mock.native.mockImplementation(state([note,pinned,trashed]));
 const backRef:{current:(()=>boolean)|null}={current:null};
 render(<Notes active backRef={backRef}/>);await screen.findByText('고정한 메모');
 expect(screen.getByRole('heading',{name:'고정됨'})).toBeTruthy();expect(screen.getByRole('heading',{name:'최근'})).toBeTruthy();
 expect(screen.queryByText('지운 메모')).toBeNull();
 // 휴지통 and 복구키 보기 sit behind the top bar's ⋯, not in the list.
 expect(screen.queryByRole('button',{name:/휴지통|복구키/})).toBeNull();
 fireEvent.click(screen.getByRole('button',{name:'메모 목록 더보기'}));
 const sheet=within(await screen.findByRole('dialog'));expect(sheet.getByRole('button',{name:'휴지통 1'})).toBeTruthy();expect(sheet.getByRole('button',{name:'복구키 보기'})).toBeTruthy();
 fireEvent.click(sheet.getByRole('button',{name:'휴지통 1'}));
 await screen.findByText('지운 메모');expect(screen.queryByText('고정한 메모')).toBeNull();expect(screen.queryByRole('button',{name:'새 메모'})).toBeNull();
 act(()=>{expect(backRef.current?.()).toBe(true);});
 await screen.findByText('고정한 메모');expect(backRef.current?.()).toBe(false);
});
it('creates notes from the floating button and moves an open note to the trash',async()=>{
 render(<Notes active backRef={{current:null}}/>);await screen.findByText('제목');
 fireEvent.click(screen.getByRole('button',{name:'새 메모'}));
 fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button',{name:'체크리스트'}));
 expect(await screen.findByRole('button',{name:/항목 추가/})).toBeTruthy();
 await waitFor(()=>expect(saves().some(s=>s.type==='checklist'&&Array.isArray(s.items))).toBe(true));
 fireEvent.click(screen.getByRole('button',{name:'메모 목록'}));
 await openNote('제목');fireEvent.click(await screen.findByRole('button',{name:'고정'}));
 expect(screen.getByRole('button',{name:'고정 해제'})).toBeTruthy();
 fireEvent.click(screen.getByRole('button',{name:'메모 휴지통으로'}));
 await waitFor(()=>expect(saves().some(s=>s.id===note.id&&s.deleted===true&&s.pinned===true)).toBe(true));
 await screen.findByRole('button',{name:'새 메모'});
});
it('shows a trashed note read-only with a restore action',async()=>{
 mock.native.mockImplementation(state([note,trashed]));
 render(<Notes active backRef={{current:null}}/>);await screen.findByText('제목');await openTrash();
 fireEvent.click(await screen.findByText('지운 메모'));
 expect(await screen.findByText('휴지통에 있는 메모입니다.')).toBeTruthy();
 fireEvent.click(await rendered('내용'));expect(screen.queryByRole('textbox',{name:'메모 내용'})).toBeNull();
 expect((screen.getByRole('textbox',{name:'메모 제목'}) as HTMLInputElement).readOnly).toBe(true);
 fireEvent.click(screen.getByRole('button',{name:'복원'}));
 await waitFor(()=>expect(screen.queryByText('휴지통에 있는 메모입니다.')).toBeNull());
});
it('converts between text and checklist with one tap, colours with a circle and archives from the ⋯ menu',async()=>{
 mock.native.mockImplementation(state([{...note,body:'- [x] 우유\n빵'}]));
 render(<Notes active backRef={{current:null}}/>);await openNote('제목');
 fireEvent.click(await screen.findByRole('button',{name:'체크리스트로 바꾸기'}));
 await waitFor(()=>expect(saves().some(s=>s.type==='checklist')).toBe(true));
 const converted=saves().find(s=>s.type==='checklist')!;
 expect((converted.items as {text:string;checked:boolean}[]).map(i=>[i.text,i.checked])).toEqual([['우유',true],['빵',false]]);
 expect(await screen.findByRole('button',{name:'메모로 바꾸기'})).toBeTruthy();
 expect(screen.getByRole('button',{name:'완료 1'})).toBeTruthy();
 fireEvent.click(screen.getByRole('button',{name:'메모로 바꾸기'}));
 await waitFor(()=>expect(saves().some(s=>s.type==='text'&&s.body==='- [ ] 빵\n- [x] 우유')).toBe(true));
 fireEvent.click(screen.getByRole('button',{name:'메모 색상'}));
 fireEvent.click(within(await screen.findByRole('dialog')).getByRole('radio',{name:'청록'}));
 await waitFor(()=>expect(saves().some(s=>s.color==='teal')).toBe(true));
 expect(screen.queryByRole('button',{name:/^보관/})).toBeNull();
 fireEvent.click(screen.getByRole('button',{name:'메모 더보기'}));
 fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button',{name:'보관함으로 보내기'}));
 await waitFor(()=>expect(saves().some(s=>s.archived===true)).toBe(true));
 fireEvent.click(screen.getByRole('button',{name:'메모 목록'}));
 fireEvent.click(await screen.findByRole('button',{name:'보관함 1'}));
 expect(await screen.findByText('제목')).toBeTruthy();
});
it('filters by label chips and searches secret notes by title only',async()=>{
 const secret:MobileNote={...note,id:'d'.repeat(32),type:'secret',schema:2,title:'서버 계정',body:'',redacted:true};
 const labelled:MobileNote={...note,id:'e'.repeat(32),title:'여행',labels:['개인']};
 mock.native.mockImplementation(state([note,secret,labelled]));
 render(<Notes active backRef={{current:null}}/>);await screen.findByText('서버 계정');
 expect(screen.getByText('암호 메모')).toBeTruthy();
 fireEvent.click(screen.getByRole('button',{name:/^개인/}));
 expect(screen.queryByText('제목')).toBeNull();expect(screen.getByText('여행')).toBeTruthy();
 fireEvent.click(screen.getByRole('button',{name:/^개인/}));
 fireEvent.change(screen.getByRole('textbox',{name:'메모 검색'}),{target:{value:'계정'}});
 expect(screen.getByText('서버 계정')).toBeTruthy();expect(screen.queryByText('여행')).toBeNull();
});
it('opens a secret note with the PIN, copies natively and drops its content when the app goes to the background',async()=>{
 const locked:MobileNote={...note,id:'d'.repeat(32),type:'secret',schema:2,title:'서버 계정',body:'',redacted:true};
 const open:MobileNote={...locked,redacted:false,body:'pw: hunter2',memo:'',fields:[{id:'f',label:'pw',value:'hunter2',order:'V'}]};
 let unlocked=false;
 mock.native.mockImplementation(async(op,p)=>{
  if(op==='notesSecretStatus')return {pinSet:true,unlocked,biometric:false};
  if(op==='notesSecretUnlock'){if(p.pin!=='2468')throw new Error('PIN이 맞지 않습니다.');unlocked=true;return {unlocked:true,notes:[open]};}
  if(op==='notesSecretLock'){unlocked=false;return {};}
  if(op==='notesCopySecret'||op==='notesSecretTouch')return {unlocked};
  return {unlocked:true,notes:[unlocked?open:locked]};
 });
 render(<Notes active backRef={{current:null}}/>);await openNote('서버 계정');
 const pin=await screen.findByLabelText('PIN');
 fireEvent.change(pin,{target:{value:'1111'}});fireEvent.click(screen.getByRole('button',{name:'열기'}));
 expect(await screen.findByText('PIN이 맞지 않습니다.')).toBeTruthy();
 fireEvent.change(screen.getByLabelText('PIN'),{target:{value:'2468'}});fireEvent.click(screen.getByRole('button',{name:'열기'}));
 const value=await screen.findByRole('textbox',{name:'pw 값'}).catch(()=>screen.getByLabelText('pw 값'));
 expect((value as HTMLInputElement).type).toBe('password');
 fireEvent.click(screen.getByRole('button',{name:'값 보기'}));expect((screen.getByLabelText('pw 값') as HTMLInputElement).type).toBe('text');
 fireEvent.click(screen.getByRole('button',{name:'값 복사'}));
 await waitFor(()=>expect(mock.native).toHaveBeenCalledWith('notesCopySecret',{text:'hunter2'}));
 act(()=>{window.dispatchEvent(new Event('lakomics-notes-locked'));});
 await waitFor(()=>expect(screen.queryByLabelText('pw 값')).toBeNull());
 expect(mock.native).toHaveBeenCalledWith('notesSecretLock',{});
 expect(document.body.textContent).not.toContain('hunter2');
});
it('offers the fingerprint first when enrolled',async()=>{
 const locked:MobileNote={...note,id:'d'.repeat(32),type:'secret',schema:2,title:'서버 계정',body:'',redacted:true};
 mock.native.mockImplementation(async(op)=>op==='notesSecretStatus'?{pinSet:true,unlocked:false,biometric:true}:op==='notesSecretUnlock'?{unlocked:true,notes:[{...locked,redacted:false,fields:[],memo:''}]}:{unlocked:true,notes:[locked]});
 render(<Notes active backRef={{current:null}}/>);await openNote('서버 계정');
 await waitFor(()=>expect(mock.native).toHaveBeenCalledWith('notesSecretUnlock',{biometric:'true'}));
 expect(await screen.findByRole('textbox',{name:'암호 메모 본문'})).toBeTruthy();
});
it('keeps a newer-schema note read-only and follows a stale save into its keep-both copy',async()=>{
 const future:MobileNote={...note,id:'f'.repeat(32),title:'미래 메모',schema:3,body:'대체 본문',readOnly:true};
 const copyId='1'.repeat(32);
 mock.native.mockImplementation(async(op,p)=>op==='notesSave'?(p.id===note.id?{...note,copiedTo:copyId}:{...note,...p,pending:true}):{unlocked:true,notes:[note,future]});
 render(<Notes active backRef={{current:null}}/>);await openNote('미래 메모');
 expect(await screen.findByText('새 버전의 앱에서 만든 메모입니다. 앱을 업데이트하면 편집할 수 있습니다.')).toBeTruthy();
 expect(screen.queryByRole('button',{name:'체크리스트로 바꾸기'})).toBeNull();
 fireEvent.click(await rendered('대체 본문'));expect(screen.queryByRole('textbox',{name:'메모 내용'})).toBeNull();
 fireEvent.click(screen.getByRole('button',{name:'메모 목록'}));
 await openNote('제목');fireEvent.change(await editBody(),{target:{value:'내 수정'}});
 expect(await screen.findByText(/두 내용을 모두 보관했습니다/)).toBeTruthy();
 expect((screen.getByRole('textbox',{name:'메모 내용'}) as HTMLTextAreaElement).value).toBe('내 수정');
});

it('fits the editor above the visual keyboard, follows viewport panning, and restores on close',async()=>{
 const viewport=Object.assign(new EventTarget(),{height:1280,offsetTop:0,scale:1});
 vi.stubGlobal('visualViewport',viewport);vi.stubGlobal('innerHeight',1280);
 vi.spyOn(HTMLElement.prototype,'getBoundingClientRect').mockReturnValue({top:64,bottom:1200,left:0,right:800,width:800,height:1136,x:0,y:64,toJSON:()=>({})});
 render(<Notes active backRef={{current:null}}/>);await openNote('제목');
 const body=await editBody(),section=screen.getByRole('region',{name:'메모'});
 expect(section.style.maxHeight).toBe('1216px');
 act(()=>body.focus());
 act(()=>{viewport.height=800;viewport.dispatchEvent(new Event('resize'));});
 expect(section.style.maxHeight).toBe('736px');expect(document.activeElement).toBe(body);
 // A resized layout must not have the same keyboard height subtracted again.
 vi.stubGlobal('innerHeight',800);fireEvent(window,new Event('resize'));
 expect(section.style.maxHeight).toBe('736px');
 act(()=>{viewport.offsetTop=100;viewport.dispatchEvent(new Event('scroll'));});
 expect(section.style.maxHeight).toBe('836px');
 // The keyboard closing (Back) leaves the source view.
 act(()=>{viewport.height=1280;viewport.offsetTop=0;viewport.dispatchEvent(new Event('resize'));});
 expect(section.style.maxHeight).toBe('1216px');
 await waitFor(()=>expect(screen.queryByRole('textbox',{name:'메모 내용'})).toBeNull());
 fireEvent.click(screen.getByRole('button',{name:'메모 목록'}));await screen.findByRole('button',{name:'새 메모'});
 expect(section.style.maxHeight).toBe('');
});
it('cleans up viewport listeners on tab switches and does not treat pinch zoom as a keyboard',async()=>{
 const viewport=Object.assign(new EventTarget(),{height:700,offsetTop:0,scale:1});
 vi.stubGlobal('visualViewport',viewport);
 const removed=vi.spyOn(viewport,'removeEventListener'),backRef={current:null};
 const view=render(<Notes active backRef={backRef}/>);await openNote('제목');
 await screen.findByRole('textbox',{name:'메모 제목'});const section=screen.getByRole('region',{name:'메모'});
 expect(section.style.maxHeight).toBe('700px');
 act(()=>{viewport.scale=2;viewport.dispatchEvent(new Event('resize'));});expect(section.style.maxHeight).toBe('');
 view.rerender(<Notes active={false} backRef={backRef}/>);
 expect(removed).toHaveBeenCalledWith('resize',expect.any(Function));expect(removed).toHaveBeenCalledWith('scroll',expect.any(Function));
 view.rerender(<Notes active backRef={backRef}/>);view.unmount();expect(removed).toHaveBeenCalledTimes(4);
});
it('syncs at once from the 동기화 button and backs pending sync off while writes wait',async()=>{
 vi.useFakeTimers();
 mock.native.mockResolvedValue({unlocked:true,notes:[{...note,pending:true}]});
 render(<Notes active backRef={{current:null}}/>);await act(async()=>{});
 const syncs=()=>mock.native.mock.calls.filter(([op])=>op==='notesSync').length;
 expect(syncs()).toBe(0);
 await act(()=>vi.advanceTimersByTimeAsync(1999));expect(syncs()).toBe(0);
 await act(()=>vi.advanceTimersByTimeAsync(1));expect(syncs()).toBe(1);
 await act(()=>vi.advanceTimersByTimeAsync(3999));expect(syncs()).toBe(1);
 await act(()=>vi.advanceTimersByTimeAsync(1));expect(syncs()).toBe(2);
 fireEvent.click(screen.getByRole('button',{name:'동기화'}));await act(async()=>{});
 expect(syncs()).toBe(3);
});
