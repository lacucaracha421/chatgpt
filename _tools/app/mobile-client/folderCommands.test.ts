import {beforeEach,describe,expect,it,vi} from 'vitest';
const mocks=vi.hoisted(()=>({api:vi.fn()}));
vi.mock('./transport',()=>({api:mocks.api,errorText:(reason:unknown)=>reason instanceof Error?reason.message:''}));
import {folderCommand,folderErrorText,readFolderSnapshot,siblingNameTaken} from './folderCommands';

const authority={libraryId:'a'.repeat(32),epoch:3,contractVersion:1};
const folder=(id:string,over:Record<string,unknown>={})=>({id,kind:'tag',name:id,parentId:null,iconKey:null,colorKey:null,deleted:false,entityRevision:1,...over});
const page=(items:unknown[],over:Record<string,unknown>={})=>({libraryId:authority.libraryId,epoch:3,snapshotCursor:42,section:'classifications',items,hasMore:false,nextAfter:null,...over});
beforeEach(()=>mocks.api.mockReset());

describe('folder snapshot',()=>{
  it('pins every page to the first page\'s snapshot and reads only the folder section',async()=>{
    mocks.api.mockResolvedValueOnce(page([folder('a')],{hasMore:true,nextAfter:'a'})).mockResolvedValueOnce(page([folder('b'),folder('c',{deleted:true})]));
    const folders=await readFolderSnapshot(authority);
    expect(folders.map(item=>item.id)).toEqual(['a','b']);
    const [first,second]=mocks.api.mock.calls.map(call=>String(call[0]));
    expect(first).toBe(`/v1/classifications/authority/baseline?libraryId=${authority.libraryId}&epoch=3&limit=1000`);
    expect(second).toContain('snapshot=42');expect(second).toContain('section=classifications');expect(second).toContain('after=a');
    expect(mocks.api).toHaveBeenCalledTimes(2);
  });
  it('refuses a page of another library, another epoch, another section or another snapshot',async()=>{
    for(const bad of [{libraryId:'b'.repeat(32)},{epoch:4},{section:'assignments'}]){
      mocks.api.mockReset();mocks.api.mockResolvedValueOnce(page([folder('a')],bad));
      await expect(readFolderSnapshot(authority)).rejects.toThrow();
    }
    mocks.api.mockReset();
    mocks.api.mockResolvedValueOnce(page([folder('a')],{hasMore:true,nextAfter:'a'})).mockResolvedValueOnce(page([folder('b')],{snapshotCursor:43}));
    await expect(readFolderSnapshot(authority)).rejects.toThrow('폴더 목록이 변경되었습니다');
  });
  it('does not loop on a cursor that does not move',async()=>{
    mocks.api.mockResolvedValue(page([folder('a')],{hasMore:true,nextAfter:null}));
    await expect(readFolderSnapshot(authority)).rejects.toThrow();
    expect(mocks.api).toHaveBeenCalledTimes(1);
  });
});

describe('folder commands',()=>{
  it('sends the authority identity and the caller\'s operation id as a PUT',async()=>{
    mocks.api.mockResolvedValue({classification:folder('n')});
    await folderCommand(authority,'op-1','createClassification',{classificationId:'n',kind:'root',name:'새',parentId:null,iconKey:null,colorKey:null});
    const [path,signal,body,method]=mocks.api.mock.calls[0];
    expect(path).toBe('/v1/classifications/authority/commands');expect(signal).toBeUndefined();expect(method).toBe('PUT');
    expect(body).toEqual({libraryId:authority.libraryId,epoch:3,contractVersion:1,operationId:'op-1',commandType:'createClassification',classificationId:'n',kind:'root',name:'새',parentId:null,iconKey:null,colorKey:null});
  });
  it('admits only create and rename: move, delete and appearance are publisher-only and not expressible',()=>{
    mocks.api.mockResolvedValue({classification:null});
    // @ts-expect-error moveClassification is publisher-only on the server and has no tablet control.
    void folderCommand(authority,'op','moveClassification',{classificationId:'n',parentId:null,expectedRevision:1});
    // @ts-expect-error deleteClassification is publisher-only on the server and has no tablet control.
    void folderCommand(authority,'op','deleteClassification',{classificationId:'n',expectedRevision:1});
    void folderCommand(authority,'op','renameClassification',{classificationId:'n',name:'x',expectedRevision:2});
    expect(mocks.api).toHaveBeenCalledTimes(3);
  });
});

describe('sibling names',()=>{
  const folders=[{id:'a',name:'Game',parent_id:null},{id:'b',name:'게임',parent_id:'a'},{id:'c',name:'Game',parent_id:'a'}];
  it('compares within one parent, ignoring case and the folder being renamed',()=>{
    expect(siblingNameTaken(folders,null,' game ')).toBe(true);
    expect(siblingNameTaken(folders,null,'Game','a')).toBe(false);
    expect(siblingNameTaken(folders,'a','GAME')).toBe(true);
    expect(siblingNameTaken(folders,'b','Game')).toBe(false);
    expect(siblingNameTaken(folders,null,'다른 이름')).toBe(false);
  });
});

describe('error text',()=>{
  const coded=(code:string)=>Object.assign(new Error('raw'),{details:{detail:{code}}});
  it('turns the server\'s coded refusals into Korean sentences',()=>{
    expect(folderErrorText(coded('duplicateClassificationName'))).toBe('같은 위치에 같은 이름의 폴더가 있습니다.');
    expect(folderErrorText(coded('protectedClassification'))).toBe('오리지널 기본 영역의 이름은 유지됩니다.');
    expect(folderErrorText(coded('revisionConflict'))).toContain('다른 기기에서');
    expect(folderErrorText(coded('classificationNotFound'))).toContain('찾을 수 없습니다');
  });
  it('falls back to the transport\'s message and then to a generic one',()=>{
    expect(folderErrorText(new Error('연결 시간이 초과되었습니다.'))).toBe('연결 시간이 초과되었습니다.');
    expect(folderErrorText(coded('somethingElse'))).toBe('raw');
    expect(folderErrorText(undefined)).toBe('폴더를 변경하지 못했습니다.');
  });
});
