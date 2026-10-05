import {act,cleanup,fireEvent,render,screen,waitFor,within} from '@testing-library/react';
import {afterEach,beforeEach,it,expect,vi} from 'vitest';
import {useState} from 'react';
import {Notes,type MobileNote} from './Notes';
const mock=vi.hoisted(()=>({native:vi.fn()}));
vi.mock('./transport',()=>({native:mock.native,errorText:(e:Error)=>e.message}));
const note:MobileNote={id:'a'.repeat(32),title:'제목',body:'내용',pinned:false,deleted:false,createdAt:'2026-09-13',updatedAt:'2026-09-13',localRevision:1,pending:false,conflict:false};
const saves=()=>mock.native.mock.calls.filter(([op])=>op==='notesSave').map(([,p])=>p);
const state=(notes:MobileNote[])=>async(op:string,p:Record<string,unknown>)=>op==='notesSave'?{createdAt:'2026-09-14',updatedAt:'2026-09-14',...notes.find(n=>n.id===p.id),...p,localRevision:Number(p.expectedRevision)+1,pending:true}:{unlocked:true,notes};
beforeEach(()=>{mock.native.mockReset();mock.native.mockImplementation(state([note]));});
afterEach(()=>{cleanup();localStorage.clear();vi.useRealTimers();vi.restoreAllMocks();vi.unstubAllGlobals();});
async function openNote(title:string){fireEvent.click(await screen.findByText(title));}
async function openTrash(){fireEvent.click(await screen.findByRole('button',{name:'메모 목록 더보기'}));fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button',{name:/^휴지통/}));}
const rows=()=>screen.getAllByRole('textbox',{name:'메모 본문'}) as HTMLTextAreaElement[];
async function editBody(){return await screen.findByRole('textbox',{name:'메모 본문'});}

it('opens text as a shared plain body with the caret at the end and switches modes beside the title',async()=>{
 mock.native.mockImplementation(state([{...note,body:'## 장보기\n우유\n빵'}]));
 render(<Notes active backRef={{current:null}}/>);await openNote('제목');
 expect(rows().map(row=>row.value)).toEqual(['우유\n빵']);
 expect(document.activeElement).toBe(rows()[0]);expect(rows()[0]!.selectionStart).toBe(4);
 expect(screen.queryByPlaceholderText('메모 작성')).toBeNull();
 expect(document.querySelector('.memo-editor--touch')).toBeTruthy();
 expect(screen.queryByRole('button',{name:'마크다운 도움말'})).toBeNull();
 const modes=within(screen.getByRole('radiogroup',{name:'메모 방식'}));
 expect(modes.getByRole('radio',{name:'글'}).getAttribute('aria-checked')).toBe('true');
 fireEvent.click(modes.getByRole('radio',{name:'할 일'}));
 await waitFor(()=>expect(saves().at(-1)?.body).toBe('## 장보기\n- [ ] 우유\n- [ ] 빵'));
 fireEvent.click(screen.getAllByRole('button',{name:'완료'})[0]!);
 await waitFor(()=>expect(saves().at(-1)?.body).toBe('## 장보기\n- [x] 우유\n- [ ] 빵'));
 expect(rows().map(row=>row.value)).toEqual(['빵']);
 fireEvent.click(screen.getByRole('button',{name:/완료 1/}));
 expect(rows().map(row=>row.value)).toEqual(['빵','우유']);
 fireEvent.click(modes.getByRole('radio',{name:'글'}));
 await waitFor(()=>expect(saves().at(-1)?.body).toBe('## 장보기\n우유\n빵'));
 expect(rows().map(row=>row.value)).toEqual(['우유\n빵']);
});

it('opens legacy checklist as 할 일 and saves it as text on the first edit',async()=>{
 mock.native.mockImplementation(state([{...note,type:'checklist',body:'',items:[{id:'one',text:'우유',checked:false,order:'A'},{id:'two',text:'빵',checked:true,order:'B'}]}]));
 render(<Notes active backRef={{current:null}}/>);await openNote('제목');
 expect(screen.getByRole('radio',{name:'할 일'}).getAttribute('aria-checked')).toBe('true');
 expect(rows().map(row=>row.value)).toEqual(['우유']);expect(saves()).toHaveLength(0);
 fireEvent.change(rows()[0]!,{target:{value:'두유'}});
 await waitFor(()=>expect(saves().at(-1)).toMatchObject({type:'text',body:'- [ ] 두유\n- [x] 빵'}));
 expect(saves().at(-1)?.items).toBeUndefined();
});

it('keeps the same item nodes on blur and never uses the retired section fold preference',async()=>{
 localStorage.setItem('lakomics.notes.sectionFolds.v1',JSON.stringify({[`${note.id}:["하나",0]`]:true}));
 mock.native.mockImplementation(state([{...note,body:'## 하나\n첫 본문\n## 둘\n둘째 본문'}]));
 render(<Notes active backRef={{current:null}}/>);await openNote('제목');
 const first=rows()[0]!;fireEvent.blur(first,{relatedTarget:screen.getByRole('textbox',{name:'메모 제목'})});
 expect(rows()[0]).toBe(first);expect(rows().map(row=>row.value)).toEqual(['첫 본문','둘째 본문']);
});

it('does not show the saved indicator while an open note is being edited',async()=>{
 mock.native.mockImplementation(state([{...note,pending:true}]));
 render(<Notes active backRef={{current:null}}/>);await openNote('제목');
 expect(screen.queryByText('저장됨')).toBeNull();
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
 fireEvent.change(screen.getByRole('textbox',{name:'메모 본문'}),{target:{value:'second'}});
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
it('puts the note kinds first in the list, above the search',async()=>{
 render(<Notes active backRef={{current:null}}/>);await screen.findByText('제목');
 const kinds=screen.getByRole('radiogroup',{name:'메모 종류'}).closest('.notes-scroll > .ui-section-bar--inline') as HTMLElement;
 expect(kinds).toBeTruthy();
 expect(kinds.compareDocumentPosition(screen.getByLabelText('메모 검색'))&Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
});
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
 fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button',{name:'메모'}));
 expect((await editBody() as HTMLTextAreaElement).value).toBe('');expect(screen.getByRole('button',{name:'섹션 추가'})).toBeTruthy();
 await waitFor(()=>expect(saves().some(s=>s.type==='text')).toBe(true));
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
 expect((await editBody() as HTMLTextAreaElement).readOnly).toBe(true);
 expect(screen.queryByPlaceholderText('메모 작성')).toBeNull();
 expect((screen.getByRole('textbox',{name:'메모 제목'}) as HTMLInputElement).readOnly).toBe(true);
 fireEvent.click(screen.getByRole('button',{name:'복원'}));
 await waitFor(()=>expect(screen.queryByText('휴지통에 있는 메모입니다.')).toBeNull());
});
it('colours with a circle and archives from the more sheet',async()=>{
 render(<Notes active backRef={{current:null}}/>);await openNote('제목');
 fireEvent.click(screen.getByRole('button',{name:'메모 색상'}));
 fireEvent.click(within(await screen.findByRole('dialog')).getByRole('radio',{name:'청록'}));
 await waitFor(()=>expect(saves().some(s=>s.color==='teal')).toBe(true));
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
 // A secret note's card is masked: a lock on the title, no preview text.
 const secretCard=screen.getByText('서버 계정').closest('button')!;
 expect(within(secretCard).getByLabelText('암호 메모')).toBeTruthy();
 expect(secretCard.textContent).toContain('잠김••••••');
 fireEvent.click(screen.getByRole('button',{name:/^개인/}));
 expect(screen.queryByText('제목')).toBeNull();expect(screen.getByText('여행')).toBeTruthy();
 fireEvent.click(screen.getByRole('button',{name:/^개인/}));
 fireEvent.change(screen.getByRole('textbox',{name:'메모 검색'}),{target:{value:'계정'}});
 expect(screen.getByText('서버 계정')).toBeTruthy();expect(screen.queryByText('여행')).toBeNull();
 // Korean-aware search: 초성 and a syllable still being composed.
 fireEvent.change(screen.getByRole('textbox',{name:'메모 검색'}),{target:{value:'ㅇㅎ'}});
 expect(screen.getByText('여행')).toBeTruthy();expect(screen.queryByText('서버 계정')).toBeNull();
 fireEvent.change(screen.getByRole('textbox',{name:'메모 검색'}),{target:{value:'섭'}});
 expect(screen.getByText('서버 계정')).toBeTruthy();expect(screen.queryByText('여행')).toBeNull();
});
it('hides text note cards, saves the concealment choice and searches hidden notes by title only',async()=>{
 const visible:MobileNote={...note,id:'e'.repeat(32),title:'숨은 제목',body:'숨겨진 본문 단어'};
 mock.native.mockImplementation(state([visible]));
 render(<Notes active backRef={{current:null}}/>);
 const card=await screen.findByText('숨은 제목');
 fireEvent.click(card);
 fireEvent.click(await screen.findByRole('button',{name:'메모 더보기'}));
 fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button',{name:'목록에서 내용 숨기기'}));
 await waitFor(()=>expect(saves().some(s=>s.id===visible.id&&s.concealed===true)).toBe(true));

 fireEvent.click(screen.getByRole('button',{name:'메모 목록'}));
 const noteCard=screen.getByText('숨은 제목').closest('button')!;
 expect(within(noteCard).getByText('숨긴 메모 · 열어서 보기')).toBeTruthy();
 expect(noteCard.textContent).not.toContain('숨겨진 본문 단어');
 const search=screen.getByRole('textbox',{name:'메모 검색'});
 fireEvent.change(search,{target:{value:'숨겨진 본문 단어'}});
 expect(screen.queryByText('숨은 제목')).toBeNull();
 fireEvent.change(search,{target:{value:'숨은 제목'}});
 expect(screen.getByText('숨은 제목')).toBeTruthy();
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
 expect((await editBody() as HTMLTextAreaElement).readOnly).toBe(true);expect(screen.queryByPlaceholderText('메모 작성')).toBeNull();
 fireEvent.click(screen.getByRole('button',{name:'메모 목록'}));
 await openNote('제목');fireEvent.change(await editBody(),{target:{value:'내 수정'}});
 expect(await screen.findByText(/두 내용을 모두 보관했습니다/)).toBeTruthy();
 expect((screen.getByRole('textbox',{name:'메모 본문'}) as HTMLTextAreaElement).value).toBe('내 수정');
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
 // The keyboard closing keeps the shared editor mounted.
 act(()=>{viewport.height=1280;viewport.offsetTop=0;viewport.dispatchEvent(new Event('resize'));});
 expect(section.style.maxHeight).toBe('1216px');
 expect(screen.getByRole('textbox',{name:'메모 본문'})).toBe(body);
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
it('shows sticky-note cards: pin, checklist progress with done items struck, masked secret fields, labels and the pending dot',async()=>{
 const checklist:MobileNote={...note,id:'f'.repeat(32),type:'checklist',schema:2,title:'장보기',body:'',pinned:true,color:'green',pending:true,
   items:[{id:'1',text:'우유',checked:false,order:'a'},{id:'2',text:'두부',checked:true,order:'b'},{id:'3',text:'대파',checked:false,order:'c'}]};
 const secret:MobileNote={...note,id:'1'.repeat(32),type:'secret',schema:2,title:'와이파이',body:'',fields:[{id:'x',label:'집',value:'hunter2',order:'a'}],memo:'비밀 메모'};
 const text:MobileNote={...note,id:'2'.repeat(32),title:'',body:'**택배** 보관함',labels:['작업']};
 mock.native.mockImplementation(state([checklist,secret,text]));
 render(<Notes active backRef={{current:null}}/>);
 const card=(await screen.findByText('장보기')).closest('button')!;
 expect(within(card).getByLabelText('고정됨')).toBeTruthy();
 expect(card.style.getPropertyValue('--note-tint')).not.toBe('');
 expect(card.querySelector('.notes-card__progress')!.textContent).toBe('1/3 완료');
 // Open items first, then done ones (struck through).
 expect([...card.querySelectorAll('.notes-card__checklist>.notes-card__check')].map(el=>[el.querySelector('.notes-card__check-text')?.textContent,el.className])).toEqual([['우유','notes-card__check'],['대파','notes-card__check'],['두부','notes-card__check is-done']]);
 expect(within(card).getByLabelText('동기화 대기')).toBeTruthy();
 expect(card.querySelector('.notes-card__pending')).toBeTruthy();
 const secretCard=screen.getByText('와이파이').closest('button')!;
 expect(secretCard.textContent).toContain('집••••••');
 expect(secretCard.textContent).not.toContain('hunter2');expect(secretCard.textContent).not.toContain('비밀 메모');
 expect(within(secretCard).queryByLabelText('고정됨')).toBeNull();
 const textCard=screen.getByText('제목 없는 메모').closest('button')!;
 expect(textCard.querySelector('.notes-card__text')!.textContent).toBe('**택배** 보관함');
 expect(textCard.querySelector('.notes-card__labels')!.textContent).toBe('작업');
 // Pinned and recent notes keep their own masonry blocks; a tap still opens the note.
 expect(document.querySelectorAll('.notes-grid')).toHaveLength(2);
 fireEvent.click(card);
 expect(await screen.findByRole('button',{name:'메모 목록'})).toBeTruthy();
});
// Mirrors App: the Home origin lives above Notes and is dropped by `onHomeEntryGone`.
function HomeHost({backRef,id,home}:{backRef:{current:(()=>boolean)|null};id:string;home:()=>void}){
 const [fromHome,setFromHome]=useState(true);
 return <Notes active backRef={backRef} request={{id,key:1}} onReturnHome={fromHome?()=>{setFromHome(false);home();}:undefined} onHomeEntryGone={fromHome?()=>setFromHome(false):undefined}/>;
}
it('forgets the Home origin after the note opened from Home is trashed, so another note closes to the list',async()=>{
 const other={...note,id:'b'.repeat(32),title:'다른 메모',body:'다른 내용'};
 mock.native.mockImplementation(state([note,other]));
 const backRef:{current:(()=>boolean)|null}={current:null},home=vi.fn();
 render(<HomeHost backRef={backRef} id={note.id} home={home}/>);
 expect((await screen.findByRole('textbox',{name:'메모 본문'}) as HTMLTextAreaElement).value).toBe('내용');
 fireEvent.click(screen.getByRole('button',{name:'메모 휴지통으로'}));
 await openNote('다른 메모');
 expect((await screen.findByRole('textbox',{name:'메모 본문'}) as HTMLTextAreaElement).value).toBe('다른 내용');
 act(()=>{expect(backRef.current!()).toBe(true);});
 expect(home).not.toHaveBeenCalled();
 expect(await screen.findByText('다른 메모')).toBeTruthy();
 expect(screen.queryByRole('textbox',{name:'메모 제목'})).toBeNull();
});
it('leaves the list to App after the note opened from Home is trashed from its sheet',async()=>{
 mock.native.mockImplementation(state([note]));
 const backRef:{current:(()=>boolean)|null}={current:null},home=vi.fn();
 render(<HomeHost backRef={backRef} id={note.id} home={home}/>);
 expect((await screen.findByRole('textbox',{name:'메모 본문'}) as HTMLTextAreaElement).value).toBe('내용');
 fireEvent.click(screen.getByRole('button',{name:'메모 더보기'}));
 fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button',{name:'휴지통으로 보내기'}));
 await waitFor(()=>expect(saves().some(s=>s.deleted===true)).toBe(true));
 // On the list, Back is no longer a Notes step: App's tab fallback handles it, without the Home return.
 act(()=>{expect(backRef.current!()).toBe(false);});
 expect(home).not.toHaveBeenCalled();
});
it('opens the note Home asks for, once per request',async()=>{
 const other={...note,id:'b'.repeat(32),title:'다른 메모',body:'다른 내용'};
 mock.native.mockImplementation(state([note,other]));
 const view=render(<Notes active backRef={{current:null}} request={{id:other.id,key:1}}/>);
 expect((await screen.findByRole('textbox',{name:'메모 본문'}) as HTMLTextAreaElement).value).toBe('다른 내용');
 expect((screen.getByRole('textbox',{name:'메모 제목'}) as HTMLInputElement).value).toBe('다른 메모');
 view.rerender(<Notes active backRef={{current:null}} request={{id:note.id,key:2}}/>);
 expect((await screen.findByRole('textbox',{name:'메모 본문'}) as HTMLTextAreaElement).value).toBe('내용');
});
it('returns a note opened from Home to Home, closing a deeper sheet first',async()=>{
 mock.native.mockImplementation(state([note]));
 const backRef:{current:(()=>boolean)|null}={current:null},home=vi.fn();
 const view=render(<Notes active backRef={backRef} request={{id:note.id,key:1}} onReturnHome={home}/>);
 expect((await screen.findByRole('textbox',{name:'메모 본문'}) as HTMLTextAreaElement).value).toBe('내용');
 fireEvent.click(screen.getByRole('button',{name:'메모 더보기'}));
 act(()=>{expect(backRef.current!()).toBe(true);});
 expect(home).not.toHaveBeenCalled();
 act(()=>{expect(backRef.current!()).toBe(true);});
 expect(home).toHaveBeenCalledTimes(1);
 // The on-screen arrow of a note opened from Home returns Home too.
 view.rerender(<Notes active backRef={backRef} request={{id:note.id,key:2}} onReturnHome={home}/>);
 fireEvent.click(await screen.findByRole('button',{name:'메모 목록'}));
 expect(home).toHaveBeenCalledTimes(2);
 // Without a Home origin, leaving the note shows the list as before.
 view.rerender(<Notes active backRef={backRef} request={{id:note.id,key:3}}/>);
 fireEvent.click(await screen.findByRole('button',{name:'메모 목록'}));
 expect(home).toHaveBeenCalledTimes(2);
 act(()=>{expect(backRef.current!()).toBe(false);});
});


it('opens a text editor at the end so native Backspace can delete immediately',async()=>{
 render(<Notes active backRef={{current:null}}/>);await openNote('제목');
 await waitFor(()=>expect(document.activeElement).toBe(screen.getByRole('textbox',{name:'메모 본문'})));
 const area=document.activeElement as HTMLTextAreaElement;
 expect(area.selectionStart).toBe(area.value.length);
 // jsdom has no native editing default action: apply the deletion at the actual selection.
 fireEvent.keyDown(area,{key:'Backspace'});
 fireEvent.input(area,{target:{value:area.value.slice(0,area.selectionStart!-1)}});
 await waitFor(()=>expect(saves().at(-1)?.body).toBe('내'));
});
it('keeps save feedback quiet through repeated typing and delayed save acknowledgements',async()=>{
 let finish!:(value:MobileNote)=>void;
 mock.native.mockImplementation(async(op,p)=>op==='notesSave'?new Promise(resolve=>{finish=resolve;}):{unlocked:true,notes:[note]});
 render(<Notes active backRef={{current:null}}/>);await openNote('제목');
 const area=screen.queryByRole('textbox',{name:'메모 본문'})??await editBody();
 const indicator=document.querySelector('.note-open .notes-top .notes-save-state')!;
 const initial=indicator.textContent;
 fireEvent.change(area,{target:{value:'한'}});
 expect(indicator.textContent).toBe(initial);
 fireEvent.change(area,{target:{value:'한국'}});
 expect(indicator.textContent).toBe(initial);
 await act(async()=>finish({...note,body:'한',localRevision:2,pending:true}));
 expect(indicator.textContent).toBe(initial);
 await act(async()=>finish({...note,body:'한국',localRevision:3,pending:true}));
 expect(indicator.textContent).toBe(initial);
});
it('does not save or rewrite intermediate jamo, even when an earlier save returns merged text',async()=>{
 let finish!:(value:MobileNote)=>void;
 mock.native.mockImplementation(async(op,p)=>op==='notesSave'&&p.body==='before'?new Promise(resolve=>{finish=resolve;}):op==='notesSave'?{...note,...p,localRevision:3,pending:true}:{unlocked:true,notes:[note]});
 render(<Notes active backRef={{current:null}}/>);await openNote('제목');
 const area=(screen.queryByRole('textbox',{name:'메모 본문'})??await editBody()) as HTMLTextAreaElement;
 act(()=>area.focus());fireEvent.change(area,{target:{value:'before'}});
 fireEvent.compositionStart(area);
 fireEvent.compositionUpdate(area,{data:'ㅎ'});fireEvent.input(area,{target:{value:'beforeㅎ'},isComposing:true});
 const setter=vi.spyOn(area,'value','set');
 await act(async()=>finish({...note,body:'server merge',localRevision:2,pending:true}));
 expect(area.value).toBe('beforeㅎ');expect(setter).not.toHaveBeenCalled();
 setter.mockRestore();
 fireEvent.compositionUpdate(area,{data:'하'});fireEvent.input(area,{target:{value:'before하'},isComposing:true});
 expect(saves()).toHaveLength(1);
 fireEvent.input(area,{target:{value:'before한'},isComposing:true});fireEvent.compositionEnd(area,{data:'한'});
 await waitFor(()=>expect(saves().at(-1)?.body).toBe('before한'));
 expect(area.value).toBe('before한');
});


it('keeps a section item and composing value through viewport updates, ignoring Enter and Backspace',async()=>{
 mock.native.mockImplementation(state([{...note,body:'## 하나\n첫 본문\n## 둘\n둘째 본문'}]));
 const viewport=Object.assign(new EventTarget(),{height:800,offsetTop:0,scale:1});vi.stubGlobal('visualViewport',viewport);
 render(<Notes active backRef={{current:null}}/>);await openNote('제목');
 const area=rows()[0]!;act(()=>area.focus());
 fireEvent.compositionStart(area);fireEvent.input(area,{target:{value:'ㅎ'},isComposing:true});
 const setter=vi.spyOn(area,'value','set');
 act(()=>{viewport.height=1100;viewport.dispatchEvent(new Event('resize'));});
 fireEvent.keyDown(area,{key:'Enter'});fireEvent.keyDown(area,{key:'Backspace'});
 expect(rows()[0]).toBe(area);expect(area.value).toBe('ㅎ');expect(setter).not.toHaveBeenCalled();expect(saves()).toHaveLength(0);
 setter.mockRestore();
 fireEvent.input(area,{target:{value:'한'},isComposing:true});
 const finalSetter=vi.spyOn(area,'value','set');fireEvent.compositionEnd(area,{data:'한'});
 await waitFor(()=>expect(saves().at(-1)?.body).toBe('## 하나\n한\n## 둘\n둘째 본문'));
 expect(rows()[0]).toBe(area);expect(area.value).toBe('한');expect(finalSetter).not.toHaveBeenCalled();
});

it('keeps an item node when typing heading syntax as literal text',async()=>{
 render(<Notes active backRef={{current:null}}/>);await openNote('제목');
 const area=await editBody();fireEvent.change(area,{target:{value:'## 제목'}});
 expect(rows()[0]).toBe(area);
 fireEvent.compositionStart(area);fireEvent.input(area,{target:{value:'## 제목ㅎ'},isComposing:true});
 fireEvent.input(area,{target:{value:'## 제목한'},isComposing:true});fireEvent.compositionEnd(area,{data:'한'});
 await waitFor(()=>expect(saves().at(-1)?.body).toBe('\\## 제목한'));
 expect(rows()[0]).toBe(area);
});

it('composes the note title without saving intermediate jamo',async()=>{
 render(<Notes active backRef={{current:null}}/>);await openNote('제목');
 const title=screen.getByRole('textbox',{name:'메모 제목'}) as HTMLInputElement;act(()=>title.focus());
 fireEvent.compositionStart(title);fireEvent.compositionUpdate(title,{data:'ㅎ'});fireEvent.input(title,{target:{value:'ㅎ'},isComposing:true});
 expect(saves()).toHaveLength(0);
 fireEvent.input(title,{target:{value:'한'},isComposing:true});fireEvent.compositionEnd(title,{data:'한'});
 await waitFor(()=>expect(saves().at(-1)?.title).toBe('한'));expect(title.value).toBe('한');
});


it('keeps composition on the same node until a keep-both save moves it, then saves the syllable into the copy',async()=>{
 const copyId='b'.repeat(32);let finish!:(value:MobileNote)=>void;
 mock.native.mockImplementation(async(op,p)=>op==='notesSave'&&p.body==='before'?new Promise(resolve=>{finish=resolve;}):op==='notesSave'?{...note,...p,localRevision:2,pending:true}:{unlocked:true,notes:[note]});
 render(<Notes active backRef={{current:null}}/>);await openNote('제목');
 const area=await screen.findByRole('textbox',{name:'메모 본문'}) as HTMLTextAreaElement;
 fireEvent.change(area,{target:{value:'before'}});fireEvent.compositionStart(area);
 fireEvent.input(area,{target:{value:'beforeㅎ'},isComposing:true});
 await act(async()=>finish({...note,body:'remote',copiedTo:copyId,localRevision:2,pending:true}));
 expect(screen.getByRole('textbox',{name:'메모 본문'})).toBe(area);expect(area.value).toBe('beforeㅎ');
 fireEvent.input(area,{target:{value:'before한'},isComposing:true});fireEvent.compositionEnd(area,{data:'한'});
 await waitFor(()=>expect(saves().at(-1)).toMatchObject({id:copyId,body:'before한'}));
 expect((screen.getByRole('textbox',{name:'메모 본문'}) as HTMLTextAreaElement).value).toBe('before한');
});


it('waits for compositionend before leaving a body that lost focus',async()=>{
 render(<Notes active backRef={{current:null}}/>);await openNote('제목');
 const area=await screen.findByRole('textbox',{name:'메모 본문'}) as HTMLTextAreaElement;
 fireEvent.compositionStart(area);fireEvent.input(area,{target:{value:'ㅎ'},isComposing:true});
 act(()=>screen.getByRole('textbox',{name:'메모 제목'}).focus());
 expect(screen.getByRole('textbox',{name:'메모 본문'})).toBe(area);expect(saves()).toHaveLength(0);
 fireEvent.input(area,{target:{value:'한'},isComposing:true});fireEvent.compositionEnd(area,{data:'한'});
 await waitFor(()=>expect(saves().at(-1)?.body).toBe('한'));
 expect(rows()[0]).toBe(area);expect(area.value).toBe('한');
});


it('offers the PC kinds and new menu with checklist counted as memo',async()=>{
 const checklist={...note,id:'b'.repeat(32),title:'장보기',type:'checklist' as const,body:'',items:[{id:'one',text:'우유',checked:false,order:'A'}]};
 const secret={...note,id:'c'.repeat(32),title:'암호 계정',type:'secret' as const,body:'',redacted:true};
 mock.native.mockImplementation(state([note,checklist,secret]));
 render(<Notes active backRef={{current:null}}/>);await screen.findByText('장보기');
 const kinds=within(screen.getByRole('radiogroup',{name:'메모 종류'}));
 expect(kinds.getAllByRole('radio').map(radio=>radio.getAttribute('aria-label'))).toEqual(['전체','메모','가계부','암호']);
 fireEvent.click(kinds.getByRole('radio',{name:'메모'}));
 expect(screen.getByText('장보기')).toBeTruthy();expect(screen.getByText('제목')).toBeTruthy();expect(screen.queryByText('암호 계정')).toBeNull();
 fireEvent.click(screen.getByRole('button',{name:'새 메모'}));
 const sheet=within(await screen.findByRole('dialog'));
 expect(sheet.getByRole('button',{name:'메모'})).toBeTruthy();expect(sheet.getByRole('button',{name:'암호 메모'})).toBeTruthy();expect(sheet.getByRole('button',{name:'가계부'})).toBeTruthy();expect(sheet.queryByRole('button',{name:'체크리스트'})).toBeNull();
});
it('clears the retired quick-section preferences when Notes starts, even while locked',async()=>{
  localStorage.setItem('lakomics.notes.quickSection.v1.'+note.id,JSON.stringify(['private section',0]));
  localStorage.setItem('lakomics.notes.quickSection.v2.'+note.id,'1');
  localStorage.setItem('unrelated','keep');
  mock.native.mockResolvedValue({unlocked:false,notes:[]});
  render(<Notes active backRef={{current:null}}/>);
  await screen.findByLabelText('메모 복구 키');
  expect(localStorage.getItem('lakomics.notes.quickSection.v1.'+note.id)).toBeNull();
  expect(localStorage.getItem('lakomics.notes.quickSection.v2.'+note.id)).toBeNull();
  expect(localStorage.getItem('unrelated')).toBe('keep');
});
it('adds a tablet section under a chip filter and has no bottom quick-add field',async()=>{
 mock.native.mockImplementation(state([{...note,body:'## 하나\nfirst\n## 둘\nlast'}]));
 render(<Notes active backRef={{current:null}}/>);await openNote('제목');
 expect(screen.queryByPlaceholderText('메모 작성')).toBeNull();expect(screen.queryByRole('combobox',{name:'넣을 섹션'})).toBeNull();
 // 섹션 추가 is its own button after the sections; the character count is the editor's last line.
 const footer=document.querySelector('.notes-editor__inner > .notes-memo-footer')!;
 expect(footer.textContent).toMatch(/자$/);expect(footer.parentElement!.lastElementChild).toBe(footer);
 expect(screen.getByRole('button',{name:'섹션 추가'}).compareDocumentPosition(footer)&Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
 fireEvent.click(within(screen.getByLabelText('메모 섹션')).getByRole('button',{name:'하나'}));
 fireEvent.click(screen.getByRole('button',{name:'섹션 추가'}));
 const name=screen.getByRole('textbox',{name:'섹션 이름'});expect(document.activeElement).toBe(name);
 fireEvent.change(name,{target:{value:'새 이름'}});fireEvent.keyDown(name,{key:'Enter'});
 expect(rows()).toHaveLength(1);expect(document.activeElement).toBe(rows()[0]);
 await waitFor(()=>expect(saves().at(-1)?.body).toContain('## 새 이름'));
});

it('excludes secret gates and editors from the native resume snapshot, then releases on leave',async()=>{
 const sensitive=vi.fn();window.LakomicsNative={request:vi.fn(),cancel:vi.fn(),setResumeSnapshotSensitive:sensitive};
 const secret:MobileNote={...note,id:'s'.repeat(32),title:'스냅샷 제외 메모',type:'secret',redacted:true,fields:[],memo:''};
 mock.native.mockImplementation(state([secret]));
 const props={active:true,backRef:{current:null},request:null};
 const view=render(<Notes {...props}/>);
 try {
   await openNote('스냅샷 제외 메모');expect(sensitive).toHaveBeenLastCalledWith(true);
   act(()=>window.dispatchEvent(new Event('lakomics-notes-locked')));
   expect(sensitive).toHaveBeenLastCalledWith(true);
   view.rerender(<Notes {...props} active={false}/>);expect(sensitive).toHaveBeenLastCalledWith(false);
   view.unmount();expect(sensitive).toHaveBeenLastCalledWith(false);
 } finally {delete window.LakomicsNative;}
});

it('protects the recovery sheet before its key arrives and releases protection on close or leaving Notes',async()=>{
 const sensitive=vi.fn();window.LakomicsNative={request:vi.fn(),cancel:vi.fn(),setResumeSnapshotSensitive:sensitive};
 let deliver!: (value:{key:string})=>void;
 const pendingKey=new Promise<{key:string}>(resolve=>{deliver=resolve;});
 const base=state([note]);mock.native.mockImplementation((op:string,p:Record<string,unknown>)=>op==='notesRecoveryKey'?pendingKey:base(op,p));
 const backRef={current:null as (()=>boolean)|null},props={active:true,backRef};
 const view=render(<Notes {...props}/>);
 try {
  fireEvent.click(await screen.findByRole('button',{name:'메모 목록 더보기'}));
  expect(sensitive).toHaveBeenLastCalledWith(false);
  fireEvent.click(within(screen.getByRole('dialog')).getByRole('button',{name:'복구키 보기'}));
  expect(sensitive).toHaveBeenLastCalledWith(true);
  await act(async()=>deliver({key:'a'.repeat(64)}));
  expect((await screen.findByRole('textbox',{name:'복구키'}) as HTMLTextAreaElement).value).toBe('a'.repeat(64));
  expect(sensitive).toHaveBeenLastCalledWith(true);
  act(()=>{backRef.current?.();});expect(sensitive).toHaveBeenLastCalledWith(false);
  fireEvent.click(screen.getByRole('button',{name:'메모 목록 더보기'}));
  fireEvent.click(within(screen.getByRole('dialog')).getByRole('button',{name:'복구키 보기'}));
  expect(sensitive).toHaveBeenLastCalledWith(true);
  view.rerender(<Notes {...props} active={false}/>);expect(sensitive).toHaveBeenLastCalledWith(false);
  view.unmount();expect(sensitive).toHaveBeenLastCalledWith(false);
 } finally {delete window.LakomicsNative;}
});
