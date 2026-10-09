import {fireEvent, render, screen, waitFor, cleanup} from '@testing-library/react';
import {afterEach, expect, it, vi} from 'vitest';
import {PersonProfileEditor, ProfileCompare, profileGroupText} from './PersonProfileEditor';
import {ProfileManualMark} from './PersonProfileRows';
import {profileExpected, type ProfilePerson} from './personProfileFields';
const person:ProfilePerson={displayName:'한국 이름',nameJa:'日本名',stashdbId:'s',stashdbProfile:{heightCm:160,bandIn:32,waistIn:24,hipIn:34},profile:{heightCm:160,bandIn:32,waistIn:24,hipIn:34},profileOverrides:{}};
afterEach(cleanup);
it('sends only touched fields and snaps cm to the integer-inch storage value', async()=>{
  const save=vi.fn().mockResolvedValue(undefined);
  render(<PersonProfileEditor person={person} onClose={()=>{}} onSave={save}/>);
  fireEvent.change(screen.getByLabelText('B (cm)'),{target:{value:'84'}});fireEvent.blur(screen.getByLabelText('B (cm)'));
  expect(screen.getByLabelText('B (cm)')).toHaveValue('84');
  fireEvent.change(screen.getByLabelText('키 (cm)'),{target:{value:''}});
  fireEvent.click(screen.getByText('저장'));
  await waitFor(()=>expect(save).toHaveBeenCalledWith({bandIn:33,heightCm:null},profileExpected(person,{bandIn:33,heightCm:null})));
});
it('rounds a cm value on blur and never acquires ownership for an unchanged measurement',async()=>{
 const save=vi.fn(),close=vi.fn();render(<PersonProfileEditor person={person} onClose={close} onSave={save}/>);
 fireEvent.change(screen.getByLabelText('B (cm)'),{target:{value:'82'}});fireEvent.blur(screen.getByLabelText('B (cm)'));expect(screen.getByLabelText('B (cm)')).toHaveValue('81');
 fireEvent.click(screen.getByText('저장'));await waitFor(()=>expect(close).toHaveBeenCalled());expect(save).not.toHaveBeenCalled();
});
it('resets every size member and keeps source values separate from the draft',async()=>{
 const save=vi.fn().mockResolvedValue(undefined);render(<PersonProfileEditor person={{...person,profileOverrides:{bandIn:33},profile:{...person.profile,bandIn:33}}} onClose={()=>{}} onSave={save}/>);
 fireEvent.click(screen.getByText('되돌리기'));fireEvent.click(screen.getByText('저장'));
 await waitFor(()=>expect(save).toHaveBeenCalledWith({bandIn:{reset:true},waistIn:{reset:true},hipIn:{reset:true}},expect.any(Object)));
});
it('keeps explicit empty values and hides source/reset affordances without a StashDB link',()=>{
 render(<PersonProfileEditor person={{...person,stashdbId:null,profileOverrides:{heightCm:null},profile:{heightCm:null}}} onClose={()=>{}} onSave={vi.fn()}/>);
 expect(screen.queryByText('직접 입력')).toBeNull();expect(screen.queryByText('되돌리기')).toBeNull();expect(screen.getAllByText('비움').length).toBeGreaterThan(0);
});
it('validates calendar dates and https URLs without dropping the draft',async()=>{
 const save=vi.fn();render(<PersonProfileEditor person={person} onClose={()=>{}} onSave={save}/>);
 fireEvent.change(screen.getByLabelText('출생 연도'),{target:{value:'2001'}});fireEvent.change(screen.getByLabelText('출생 월'),{target:{value:'02'}});fireEvent.change(screen.getByLabelText('출생 일'),{target:{value:'30'}});
 fireEvent.click(screen.getByText('저장'));await screen.findByRole('alert');expect(save).not.toHaveBeenCalled();expect(screen.getByLabelText('출생 일')).toHaveValue('30');
});
it('shows a compare popover for an explicit empty override',()=>{
 render(<ProfileManualMark person={{...person,profile:{heightCm:null},profileOverrides:{heightCm:null}}} keys={['heightCm']} label="키" onSave={vi.fn()} onEdit={vi.fn()}/>);
 fireEvent.click(screen.getByLabelText('키 직접 입력 비교'));expect(screen.getByRole('dialog',{name:'키 비교'})).toHaveTextContent('비움');expect(screen.getByRole('dialog')).toHaveTextContent('160 cm');
 expect(screen.getByRole('dialog').parentElement).toBe(document.body);
 fireEvent.keyDown(document,{key:'Escape'});expect(screen.queryByRole('dialog')).toBeNull();expect(screen.getByLabelText('키 직접 입력 비교')).toHaveFocus();
});
it('retains a dirty draft when closing and validates a manual http link',async()=>{
 const save=vi.fn(),close=vi.fn();render(<PersonProfileEditor person={person} onClose={close} onSave={save}/>);
 fireEvent.click(screen.getByText('링크 추가'));fireEvent.change(screen.getByLabelText('링크 1 URL'),{target:{value:'http://example.com'}});
 expect(screen.getByLabelText('링크 1 URL')).toHaveAttribute('aria-invalid','true');fireEvent.click(screen.getByText('취소'));expect(screen.getByRole('dialog',{name:'편집한 내용을 버릴까요?'})).toBeVisible();expect(close).not.toHaveBeenCalled();
 fireEvent.click(screen.getByText('계속 편집'));expect(screen.getByLabelText('링크 1 URL')).toHaveValue('http://example.com');fireEvent.click(screen.getByText('저장'));expect(save).not.toHaveBeenCalled();
});
it('never rounds an untouched legacy float into manual ownership when its displayed cm is re-entered',async()=>{
 const save=vi.fn(),close=vi.fn();render(<PersonProfileEditor person={{...person,profile:{...person.profile,bandIn:32.2},stashdbProfile:{...person.stashdbProfile,bandIn:32.2}}} onClose={close} onSave={save}/>);
 fireEvent.change(screen.getByLabelText('B (cm)'),{target:{value:'82'}});fireEvent.click(screen.getByText('저장'));await waitFor(()=>expect(close).toHaveBeenCalled());expect(save).not.toHaveBeenCalled();
});

it('shows an explicitly cleared member of the size group as empty',()=>{
 expect(profileGroupText({...person,profile:{bandIn:32,waistIn:null,hipIn:34},profileOverrides:{waistIn:null}},['bandIn','waistIn','hipIn'])).toContain('W 비움');
});

it.each([[],null])('adding then removing links does not acquire ownership from %j',async urls=>{
 const save=vi.fn(),close=vi.fn();render(<PersonProfileEditor person={{...person,profile:{...person.profile,urls}}} onClose={close} onSave={save}/>);
 fireEvent.click(screen.getByText('링크 추가'));fireEvent.click(screen.getByLabelText('링크 1 제거'));fireEvent.click(screen.getByText('저장'));
 await waitFor(()=>expect(close).toHaveBeenCalled());expect(save).not.toHaveBeenCalled();
});
it('explicitly clearing empty links remains an intentional manual clear',async()=>{
 const save=vi.fn().mockResolvedValue(undefined);render(<PersonProfileEditor person={{...person,profile:{...person.profile,urls:[]}}} onClose={()=>{}} onSave={save}/>);
 fireEvent.click(screen.getByText('비우기'));fireEvent.click(screen.getByText('링크 추가'));fireEvent.click(screen.getByLabelText('링크 1 제거'));fireEvent.click(screen.getByText('저장'));
 await waitFor(()=>expect(save).toHaveBeenCalledWith({urls:null},{urls:{value:[],overridden:false}}));
});
it('freezes opening tokens across an incoming value and reloads only by request',async()=>{
 const save=vi.fn().mockResolvedValue(undefined);const props={onClose:()=>{},onSave:save};
 const {rerender}=render(<PersonProfileEditor person={person} {...props}/>);
 fireEvent.change(screen.getByLabelText('키 (cm)'),{target:{value:'170'}});
 const newer={...person,profile:{...person.profile,heightCm:180},profileOverrides:{heightCm:180}};
 rerender(<PersonProfileEditor person={newer} {...props}/>);
 expect(screen.getByRole('status')).toHaveTextContent('다른 기기에서 바뀌었어요');expect(screen.getByLabelText('키 (cm)')).toHaveValue('170');
 fireEvent.click(screen.getByText('저장'));await waitFor(()=>expect(save).toHaveBeenCalledWith({heightCm:170},{heightCm:{value:160,overridden:false}}));
 fireEvent.click(screen.getByText('새로 불러오기'));expect(screen.getByLabelText('키 (cm)')).toHaveValue('180');expect(screen.queryByRole('status')).toBeNull();
});
it('labels name baselines by their real source in the editor and compare',()=>{
 const named={...person,displayName:'내 이름',profileOverrides:{displayName:'내 이름',heightCm:170},profileBaseNames:{displayName:'원 이름',nameJa:'日本名'}};
 const {unmount}=render(<PersonProfileEditor person={named} onClose={()=>{}} onSave={vi.fn()}/>);
 expect(screen.getByText('모두 되돌리기')).toBeVisible();expect(screen.getByText(/원래 이름 원 이름/)).toBeVisible();expect(screen.getByText(/StashDB 160 cm/)).toBeVisible();unmount();
 render(<ProfileCompare person={named} keys={['displayName']} onEdit={()=>{}} onReset={()=>{}}/>);expect(screen.getByText('원래 이름')).toBeVisible();expect(screen.queryByText('StashDB')).toBeNull();
});
