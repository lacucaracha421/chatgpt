import {act,cleanup,fireEvent,render,screen,waitFor} from '@testing-library/react';
import {afterEach,it,expect,vi} from 'vitest';
import {useState} from 'react';
import {NoteChecklist,DRAG_HOLD_MS} from './NoteChecklist';
import {SecretEditor,SecretGate,REVEAL_MS} from './NoteSecret';
import {byOrder,type ChecklistItem} from '../src/notes/model';
import type {NotesStore} from '../src/notes/store';
vi.mock('./transport',()=>({native:vi.fn(),errorText:(e:Error)=>e.message}));
afterEach(()=>{cleanup();vi.useRealTimers();vi.restoreAllMocks();});
const start:ChecklistItem[]=[{id:'a',text:'우유',checked:false,order:'V'},{id:'b',text:'빵',checked:false,order:'h'},{id:'c',text:'달걀',checked:false,order:'m'},{id:'d',text:'쌀',checked:true,order:'V'}];
let latest:ChecklistItem[]=[];
function Harness(){const [items,setItems]=useState(start);latest=items;return <div className="notes-editor"><NoteChecklist items={items} onChange={setItems}/></div>;}
const openTexts=()=>latest.filter(i=>!i.checked).sort(byOrder).map(i=>i.text);

it('adds below with Enter, removes an empty item with Backspace and groups checked items under 완료',()=>{
 render(<Harness/>);
 const fields=screen.getAllByRole('textbox',{name:'체크리스트 항목'});
 fireEvent.keyDown(fields[0]!,{key:'Enter'});
 expect(openTexts()).toEqual(['우유','','빵','달걀']);
 const blank=document.activeElement as HTMLInputElement;expect(blank.value).toBe('');
 fireEvent.keyDown(blank,{key:'Backspace'});
 expect(openTexts()).toEqual(['우유','빵','달걀']);
 fireEvent.click(screen.getByRole('checkbox',{name:'빵 완료'}));
 expect(screen.getByRole('button',{name:'완료 2'})).toBeTruthy();
 fireEvent.click(screen.getByRole('button',{name:'완료 2'}));
 expect(screen.queryByRole('list',{name:'완료한 항목'})).toBeNull();
 fireEvent.click(screen.getByRole('button',{name:/항목 추가/}));expect(openTexts()).toEqual(['우유','달걀','']);
});
it('reorders only after a long press on the handle and rewrites only the moved order key',()=>{
 vi.useFakeTimers();
 render(<Harness/>);
 const rows=[...document.querySelectorAll<HTMLElement>('li[data-row]')];
 rows.forEach((row,index)=>vi.spyOn(row,'getBoundingClientRect').mockReturnValue({top:index*50,bottom:index*50+50,height:50,left:0,right:400,width:400,x:0,y:index*50,toJSON:()=>({})}));
 const handle=screen.getAllByRole('button',{name:'길게 눌러 끌어서 순서 바꾸기'})[0]!;
 // A quick touch never starts a drag.
 fireEvent.pointerDown(handle,{pointerType:'touch',pointerId:1,clientY:10});fireEvent.pointerMove(handle,{pointerType:'touch',pointerId:1,clientY:140});fireEvent.pointerUp(handle,{pointerId:1});
 expect(openTexts()).toEqual(['우유','빵','달걀']);
 fireEvent.pointerDown(handle,{pointerType:'touch',pointerId:2,clientY:10});
 act(()=>{vi.advanceTimersByTime(DRAG_HOLD_MS);});
 fireEvent.pointerMove(handle,{pointerType:'touch',pointerId:2,clientY:140});
 fireEvent.pointerUp(handle,{pointerId:2});
 expect(openTexts()).toEqual(['빵','달걀','우유']);
 const before=Object.fromEntries(start.map(i=>[i.id,i.order]));
 expect(latest.filter(i=>i.order!==before[i.id]).map(i=>i.id)).toEqual(['a']);
});
it('sets a PIN on first use and resets a forgotten PIN with the recovery key',async()=>{
 const openSecrets=vi.fn(async()=>null as string|null);
 const store={secretStatus:vi.fn(async()=>({pinSet:false,unlocked:false,biometric:false})),openSecrets} as unknown as NotesStore;
 const opened=vi.fn();
 const view=render(<SecretGate store={store} onOpened={opened}/>);
 fireEvent.change(await screen.findByLabelText('새 PIN'),{target:{value:'2468'}});fireEvent.change(screen.getByLabelText('PIN 확인'),{target:{value:'1357'}});
 fireEvent.click(screen.getByRole('button',{name:'PIN 설정'}));expect(await screen.findByText('두 PIN이 다릅니다.')).toBeTruthy();
 fireEvent.change(screen.getByLabelText('새 PIN'),{target:{value:'2468'}});fireEvent.change(screen.getByLabelText('PIN 확인'),{target:{value:'2468'}});
 fireEvent.click(screen.getByRole('button',{name:'PIN 설정'}));
 await waitFor(()=>expect(opened).toHaveBeenCalled());expect(openSecrets).toHaveBeenCalledWith('secretSetPin',{pin:'2468'});
 view.unmount();
 (store.secretStatus as ReturnType<typeof vi.fn>).mockResolvedValue({pinSet:true,unlocked:false,biometric:false});
 render(<SecretGate store={store} onOpened={opened}/>);
 fireEvent.click(await screen.findByRole('button',{name:'PIN을 잊었나요?'}));
 fireEvent.change(screen.getByLabelText('복구키'),{target:{value:'0'.repeat(64)}});
 fireEvent.change(screen.getByLabelText('새 PIN'),{target:{value:'9999'}});fireEvent.change(screen.getByLabelText('PIN 확인'),{target:{value:'9999'}});
 fireEvent.click(screen.getByRole('button',{name:'PIN 설정'}));
 await waitFor(()=>expect(openSecrets).toHaveBeenCalledWith('secretResetPin',{recoveryKey:'0'.repeat(64),pin:'9999'}));
});

it('opens at the last unfinished item and permits immediate native Backspace',()=>{
 render(<Harness/>);const field=document.activeElement as HTMLInputElement;
 expect(field).toBe(screen.getAllByRole('textbox',{name:'체크리스트 항목'})[2]);
 expect(field.selectionStart).toBe(2);
 fireEvent.keyDown(field,{key:'Backspace'});fireEvent.input(field,{target:{value:field.value.slice(0,field.selectionStart!-1)}});
 expect(openTexts()).toEqual(['우유','빵','달']);
});
it('holds jamo locally during composition and ignores Enter and Backspace without native composition flags',()=>{
 render(<Harness/>);const field=screen.getAllByRole('textbox',{name:'체크리스트 항목'})[0]!;
 fireEvent.compositionStart(field);fireEvent.compositionUpdate(field,{data:'ㅎ'});
 fireEvent.input(field,{target:{value:'ㅎ'},isComposing:true});
 expect(openTexts()[0]).toBe('우유');
 fireEvent.keyDown(field,{key:'Enter'});expect(openTexts()).toHaveLength(3);
 fireEvent.input(field,{target:{value:''},isComposing:true});fireEvent.keyDown(field,{key:'Backspace'});
 expect(openTexts()).toHaveLength(3);
 fireEvent.compositionUpdate(field,{data:'하'});fireEvent.input(field,{target:{value:'하'},isComposing:true});
 fireEvent.input(field,{target:{value:'한'},isComposing:true});fireEvent.compositionEnd(field,{data:'한'});
 expect(openTexts()[0]).toBe('한');
});


it.each(['항목 이름','계정 값','암호 메모 본문'])('protects composition in secret %s from incoming values',name=>{
 const change=vi.fn();const props={fields:[{id:'f',label:'계정',value:'기존',order:'V'}],memo:'메모',onChange:change};
 const view=render(<SecretEditor {...props}/>);const field=screen.getByLabelText(name) as HTMLInputElement|HTMLTextAreaElement;
 act(()=>field.focus());fireEvent.compositionStart(field);fireEvent.compositionUpdate(field,{data:'ㅎ'});
 fireEvent.input(field,{target:{value:'ㅎ'},isComposing:true});
 const setter=vi.spyOn(field,'value','set');
 view.rerender(<SecretEditor {...props} fields={[{...props.fields[0]!,value:'saved',label:'계정'}]} memo="saved"/>);
 expect(field.value).toBe('ㅎ');expect(setter).not.toHaveBeenCalled();expect(change).not.toHaveBeenCalled();setter.mockRestore();
 fireEvent.compositionUpdate(field,{data:'하'});fireEvent.input(field,{target:{value:'하'},isComposing:true});
 fireEvent.input(field,{target:{value:'한'},isComposing:true});fireEvent.compositionEnd(field,{data:'한'});
 expect(change).toHaveBeenCalledTimes(1);
 expect(JSON.stringify(change.mock.calls[0])).toContain('한');expect(field.value).toBe('한');
});
it('opens a secret memo at its end for immediate native Backspace',()=>{
 const change=vi.fn();render(<SecretEditor fields={[]} memo="메모" onChange={change}/>);
 const field=document.activeElement as HTMLTextAreaElement;expect(field).toBe(screen.getByLabelText('암호 메모 본문'));expect(field.selectionStart).toBe(2);
 fireEvent.keyDown(field,{key:'Backspace'});fireEvent.input(field,{target:{value:field.value.slice(0,field.selectionStart!-1)}});
 expect(change).toHaveBeenCalledWith({memo:'메'});
});
it('does not change a revealed secret input type while its IME is composing',()=>{
 vi.useFakeTimers();render(<SecretEditor fields={[{id:'f',label:'계정',value:'기존',order:'V'}]} memo="" onChange={()=>{}}/>);
 fireEvent.click(screen.getByRole('button',{name:'값 보기'}));const field=screen.getByLabelText('계정 값') as HTMLInputElement;
 act(()=>field.focus());fireEvent.compositionStart(field);
 act(()=>vi.advanceTimersByTime(REVEAL_MS));expect(field.type).toBe('text');
 fireEvent.input(field,{target:{value:'한'},isComposing:true});fireEvent.compositionEnd(field,{data:'한'});
 act(()=>vi.advanceTimersByTime(250));expect(field.type).toBe('password');
});
