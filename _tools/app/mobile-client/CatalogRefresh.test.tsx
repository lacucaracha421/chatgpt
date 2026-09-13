import {afterEach,beforeEach,describe,it,expect,vi} from 'vitest';
import {act,cleanup,fireEvent,render,screen,waitFor} from '@testing-library/react';
import {CatalogRefresh,type RefreshJob} from './CatalogRefresh';
const mocks=vi.hoisted(()=>({api:vi.fn()}));
vi.mock('./transport',()=>({api:mocks.api,errorText:(error:Error)=>error.message}));
const complete:RefreshJob={id:'job-1',language:'korean',state:'completed',pages:1,added:2,hasMore:false,error:null,publicationRevision:'new'};
beforeEach(()=>{localStorage.clear();mocks.api.mockReset();});
afterEach(()=>{cleanup();vi.useRealTimers();});
describe('server catalog refresh',()=>{
  it('requests the selected language, shows progress, and applies a completed publication once',async()=>{
    let job:RefreshJob|null=null;
    mocks.api.mockImplementation(async(path:string,_signal:AbortSignal,body?:unknown)=>{
      if(path.endsWith('/status'))return {capabilities:{refreshRequest:true}};
      if(body)job={...complete,state:'running',language:'japanese',publicationRevision:null};
      return {job};
    });
    const onPublished=vi.fn();
    const {rerender}=render(<CatalogRefresh active language="japanese" publication="old" endpoint="test" onPublished={onPublished}/>);
    fireEvent.click(await screen.findByRole('button',{name:'카탈로그 갱신',exact:true}));
    await screen.findByText('갱신 중');
    expect(mocks.api.mock.calls.find(([, ,body])=>body)?.[2]).toMatchObject({language:'japanese',operationId:expect.any(String)});
    expect((screen.getByRole('button',{name:'카탈로그 갱신'}) as HTMLButtonElement).disabled).toBe(true);
    job={...complete,language:'japanese'};
    rerender(<CatalogRefresh active={false} language="japanese" publication="old" endpoint="test" onPublished={onPublished}/>);
    rerender(<CatalogRefresh active language="japanese" publication="old" endpoint="test" onPublished={onPublished}/>);
    await waitFor(()=>expect(onPublished).toHaveBeenCalledTimes(1));
    expect(screen.queryByText('일본어 · 2개 추가')).toBeNull();
    expect(onPublished).toHaveBeenCalledTimes(1);
    rerender(<CatalogRefresh active language="japanese" publication="newer-pc" endpoint="test" onPublished={onPublished}/>);
    await act(async()=>{});expect(onPublished).toHaveBeenCalledTimes(1);
  });
  it('reuses a durable operation after a lost response and remount',async()=>{
    const requests:unknown[]=[];
    mocks.api.mockImplementation(async(path:string,_signal:AbortSignal,body?:unknown)=>{
      if(path.endsWith('/status'))return {capabilities:{refreshRequest:true}};
      if(body){requests.push(body);throw new Error('연결 실패');}
      return {job:null};
    });
    const props={active:true,language:'korean' as const,publication:'old',endpoint:'server-1',onPublished:vi.fn()};
    const first=render(<CatalogRefresh {...props}/>);
    fireEvent.click(await screen.findByRole('button',{name:'카탈로그 갱신',exact:true}));await screen.findByRole('alert');first.unmount();
    render(<CatalogRefresh {...props}/>);
    fireEvent.click(await screen.findByRole('button',{name:'카탈로그 갱신',exact:true}));await screen.findByRole('alert');
    expect(requests).toHaveLength(2);expect(requests[0]).toEqual(requests[1]);
  });
  it('keeps unsupported servers read-only and pauses polling when inactive',async()=>{
    mocks.api.mockResolvedValue({capabilities:{refreshRequest:false}});
    const {rerender}=render(<CatalogRefresh active={false} language="all" publication="old" endpoint="test" onPublished={vi.fn()}/>);
    expect(mocks.api).not.toHaveBeenCalled();
    rerender(<CatalogRefresh active language="all" publication="old" endpoint="test" onPublished={vi.fn()}/>);
    await waitFor(()=>expect(mocks.api).toHaveBeenCalledTimes(1));
    expect(screen.queryByRole('button')).toBeNull();
  });
  it('shows a failed job and enables retry without invalidating the existing catalog',async()=>{
    const onPublished=vi.fn();
    mocks.api.mockImplementation(async(path:string)=>path.endsWith('/status')?{capabilities:{refreshRequest:true}}:{job:{...complete,state:'failed',error:'기존 목록은 유지됩니다.'}});
    render(<CatalogRefresh active language="korean" publication="old" endpoint="test" onPublished={onPublished}/>);
    await screen.findByText('기존 목록은 유지됩니다.');
    expect((screen.getByRole('button',{name:'카탈로그 갱신',exact:true}) as HTMLButtonElement).disabled).toBe(false);
    expect(onPublished).not.toHaveBeenCalled();
  });
});
