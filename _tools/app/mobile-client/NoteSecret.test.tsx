import {act,cleanup,fireEvent,render,screen,waitFor} from '@testing-library/react';
import {afterEach,it,expect,vi} from 'vitest';
import {SecretEditor,SecretGate,REVEAL_MS} from './NoteSecret';
import type {NotesStore} from '../src/notes/store';
vi.mock('./transport',()=>({native:vi.fn(),errorText:(e:Error)=>e.message}));
afterEach(()=>{cleanup();vi.useRealTimers();vi.restoreAllMocks();});

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
