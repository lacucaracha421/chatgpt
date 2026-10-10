import {act,cleanup,fireEvent,render,screen,waitFor} from '@testing-library/react';
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
const mocks=vi.hoisted(()=>({api:vi.fn(),native:vi.fn()}));
vi.mock('./transport',()=>({api:mocks.api,native:mocks.native,errorText:(reason:unknown)=>reason instanceof Error?reason.message:String(reason)}));
import {FolderManagement,isOriginalsRoot} from './FolderManagement';
import type {Classification} from './types';

const authority={libraryId:'a'.repeat(32),epoch:2,contractVersion:1};
const entry=(id:string,name:string,parent_id:string|null=null):Classification=>({id,name,parent_id,asset_count:0});
const folders=[entry('p','부모'),entry('c','자식','p'),entry('lakomics-originals','오리지널')];
const baselineFolder=(id:string,name:string,parentId:string|null,entityRevision=4)=>({id,kind:parentId?'tag':'root',name,parentId,iconKey:null,colorKey:null,deleted:false,entityRevision});
const baseline=()=>({libraryId:authority.libraryId,epoch:2,snapshotCursor:9,section:'classifications',items:[baselineFolder('p','부모',null),baselineFolder('c','자식','p',7),baselineFolder('lakomics-originals','오리지널',null,1)],hasMore:false,nextAfter:null});
const commands=()=>mocks.api.mock.calls.filter(([path])=>path==='/v1/classifications/authority/commands');
const echo=(body:Record<string,unknown>)=>({classification:{id:body.classificationId,kind:body.kind??'tag',name:body.name,parentId:body.parentId??null,iconKey:null,colorKey:null,deleted:false,entityRevision:body.commandType==='createClassification'?1:8}});
beforeEach(()=>{
  vi.stubGlobal('matchMedia',()=>({matches:false,addEventListener(){},removeEventListener(){}}));
  mocks.api.mockReset();
  mocks.api.mockImplementation(async(path:string,_signal:unknown,body:Record<string,unknown>)=>path.includes('/baseline')?baseline():echo(body));
});
afterEach(()=>{cleanup();vi.unstubAllGlobals();});
const open=(props:Partial<Parameters<typeof FolderManagement>[0]>={})=>{
  const onClose=vi.fn(),onChanged=vi.fn();
  render(<FolderManagement authority={authority} folders={folders} onClose={onClose} onChanged={onChanged} {...props}/>);
  return {onClose,onChanged};
};
const waitEnabled=(name:string)=>waitFor(()=>expect((screen.getByRole('button',{name}) as HTMLButtonElement).disabled).toBe(false));

describe('tablet folder create and rename',()=>{
  it('creates a top-level folder as a root with the authority identity',async()=>{
    const {onClose,onChanged}=open();
    fireEvent.change(screen.getByLabelText('폴더 이름'),{target:{value:'  새 최상위  '}});
    fireEvent.click(screen.getByRole('button',{name:'만들기'}));
    await waitFor(()=>expect(onClose).toHaveBeenCalledOnce());
    const [path,signal,body,method]=commands()[0];
    expect(path).toBe('/v1/classifications/authority/commands');expect(signal).toBeUndefined();expect(method).toBe('PUT');
    expect(body).toMatchObject({libraryId:authority.libraryId,epoch:2,contractVersion:1,commandType:'createClassification',kind:'root',name:'새 최상위',parentId:null,iconKey:null,colorKey:null});
    expect(body.classificationId).toMatch(/^[0-9a-f-]{36}$/);expect(body.operationId).toMatch(/^[0-9a-f-]{36}$/);
    expect(onChanged).toHaveBeenCalledWith({type:'create',folder:expect.objectContaining({name:'새 최상위',kind:'root'})});
    expect(mocks.api.mock.calls.some(([path])=>String(path).includes('/baseline'))).toBe(false);
  });
  it('creates a child folder as a tag under the open folder, with a new id',async()=>{
    const {onChanged}=open({folder:folders[0]});
    await waitEnabled('하위 폴더 만들기');
    fireEvent.click(screen.getByRole('button',{name:'하위 폴더 만들기'}));
    fireEvent.click(screen.getByRole('button',{name:'만들기'}));
    await waitFor(()=>expect(commands()).toHaveLength(1));
    expect(commands()[0][2]).toMatchObject({commandType:'createClassification',kind:'tag',parentId:'p',name:'새 폴더'});
    expect(commands()[0][2].classificationId).not.toBe('p');
    await waitFor(()=>expect(onChanged).toHaveBeenCalledOnce());
  });
  it('renames with the revision it read and reports the confirmed folder',async()=>{
    const {onClose,onChanged}=open({folder:folders[1]});
    await waitEnabled('이름 바꾸기');
    fireEvent.click(screen.getByRole('button',{name:'이름 바꾸기'}));
    fireEvent.change(screen.getByLabelText('폴더 이름'),{target:{value:'새 이름'}});
    fireEvent.click(screen.getByRole('button',{name:'저장'}));
    await waitFor(()=>expect(onClose).toHaveBeenCalledOnce());
    expect(commands()[0][2]).toMatchObject({commandType:'renameClassification',classificationId:'c',name:'새 이름',expectedRevision:7});
    expect(onChanged).toHaveBeenCalledWith({type:'rename',folder:expect.objectContaining({id:'c',name:'새 이름'})});
  });
  it('keeps the sheet and says why when the server refuses, and retries the same operation',async()=>{
    const coded=Object.assign(new Error('raw'),{details:{detail:{code:'duplicateClassificationName'}}});
    let failing=true;
    mocks.api.mockImplementation(async(path:string,_signal:unknown,body:Record<string,unknown>)=>{
      if(path.includes('/baseline'))return baseline();
      if(failing){failing=false;throw coded;}
      return echo(body);
    });
    const {onClose}=open();
    fireEvent.change(screen.getByLabelText('폴더 이름'),{target:{value:'중복'}});
    fireEvent.click(screen.getByRole('button',{name:'만들기'}));
    expect((await screen.findByRole('alert')).textContent).toContain('같은 위치에 같은 이름의 폴더가 있습니다.');
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button',{name:'만들기'}));
    await waitFor(()=>expect(onClose).toHaveBeenCalledOnce());
    // The same intent keeps its operation id and folder id, so a lost reply cannot create it twice.
    expect(commands()).toHaveLength(2);
    expect(commands()[1][2].operationId).toBe(commands()[0][2].operationId);
    expect(commands()[1][2].classificationId).toBe(commands()[0][2].classificationId);
  });
  it('starts a new operation when the name changes',async()=>{
    mocks.api.mockImplementation(async(path:string)=>{if(path.includes('/baseline'))return baseline();throw new Error('연결 시간이 초과되었습니다.');});
    open();
    fireEvent.click(screen.getByRole('button',{name:'만들기'}));
    await screen.findByRole('alert');
    fireEvent.change(screen.getByLabelText('폴더 이름'),{target:{value:'다른 이름'}});
    fireEvent.click(screen.getByRole('button',{name:'만들기'}));
    await waitFor(()=>expect(commands()).toHaveLength(2));
    expect(commands()[1][2].operationId).not.toBe(commands()[0][2].operationId);
  });
  it('spares a round trip for an empty, too long or duplicate name',async()=>{
    open({folder:folders[0]});
    await waitEnabled('하위 폴더 만들기');
    fireEvent.click(screen.getByRole('button',{name:'하위 폴더 만들기'}));
    const save=screen.getByRole('button',{name:'만들기'}) as HTMLButtonElement;
    fireEvent.change(screen.getByLabelText('폴더 이름'),{target:{value:'   '}});
    expect(save.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText('폴더 이름'),{target:{value:'x'.repeat(201)}});
    expect(save.disabled).toBe(true);expect(screen.getByRole('status').textContent).toContain('너무 깁니다');
    fireEvent.change(screen.getByLabelText('폴더 이름'),{target:{value:'자식'}});
    expect(save.disabled).toBe(true);expect(screen.getByRole('status').textContent).toContain('같은 이름');
    expect(commands()).toHaveLength(0);
  });
  it('does not rename to the same name',async()=>{
    open({folder:folders[1]});
    await waitEnabled('이름 바꾸기');
    fireEvent.click(screen.getByRole('button',{name:'이름 바꾸기'}));
    expect((screen.getByRole('button',{name:'저장'}) as HTMLButtonElement).disabled).toBe(true);
  });
  it('offers neither move nor delete, and keeps the protected 오리지널 root name',async()=>{
    const originals=folders[2];
    expect(isOriginalsRoot(originals)).toBe(true);expect(isOriginalsRoot(folders[1])).toBe(false);
    open({folder:originals});
    await waitEnabled('하위 폴더 만들기');
    expect((screen.getByRole('button',{name:'이름 바꾸기'}) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText('오리지널 기본 영역의 이름은 유지됩니다.')).toBeTruthy();
    for(const forbidden of [/이동/,/삭제/,/아이콘/])expect(screen.queryByRole('button',{name:forbidden})).toBeNull();
    expect(screen.getByText('폴더 이동과 삭제는 PC에서 할 수 있습니다.')).toBeTruthy();
  });
  it('says so when the folder is gone and offers no action',async()=>{
    mocks.api.mockImplementation(async()=>({...baseline(),items:[baselineFolder('p','부모',null)]}));
    open({folder:folders[1]});
    expect((await screen.findByText(/삭제되었거나 옮겨졌습니다/)).textContent).toBeTruthy();
    expect((screen.getByRole('button',{name:'이름 바꾸기'}) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole('button',{name:'하위 폴더 만들기'}) as HTMLButtonElement).disabled).toBe(true);
  });
  it('shows a retry when the revision cannot be read',async()=>{
    let failing=true;
    mocks.api.mockImplementation(async()=>{if(failing){failing=false;throw new Error('연결 시간이 초과되었습니다.');}return baseline();});
    open({folder:folders[1]});
    expect((await screen.findByRole('alert')).textContent).toContain('연결 시간이 초과되었습니다.');
    await act(async()=>fireEvent.click(screen.getByRole('button',{name:'다시 시도'})));
    await waitEnabled('이름 바꾸기');
  });
});
