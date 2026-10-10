import {beforeEach,expect,it,vi} from 'vitest';
const mocks=vi.hoisted(()=>({api:vi.fn()}));
vi.mock('./transport',()=>({api:mocks.api}));
import {cachedDescription,descriptionMeta,descriptionPath,readDescription} from './descriptionSearch';
import {pagePath,viewKey} from './model';
import type {View} from './types';
let sequence=0,endpoint='';
beforeEach(()=>{mocks.api.mockReset();endpoint=`device-${++sequence}`;});

it('builds the exact client route: trimmed text, bounded length, force only when set',()=>{
  expect(descriptionPath({query:'  눈 내리는 겨울 ',force:false})).toBe('/v1/library/search/description?q=%EB%88%88+%EB%82%B4%EB%A6%AC%EB%8A%94+%EA%B2%A8%EC%9A%B8&limit=200');
  expect(descriptionPath({query:'눈',force:true},7)).toBe('/v1/library/search/description?q=%EB%88%88&limit=7&force=true');
  expect(new URL(descriptionPath({query:'가'.repeat(500),force:false}),'https://x').searchParams.get('q')).toHaveLength(200);
});
it('reads only what the server states; anything else is not ready',()=>{
  expect(descriptionMeta({ready:true,gated:true})).toEqual({ready:true,gated:true});
  expect(descriptionMeta({ready:'yes'})).toEqual({ready:false,gated:false});
  expect(descriptionMeta(null)).toEqual({ready:false,gated:false});
});
it('a description view is one ranked list: its own route and identity, no cursor or filters',()=>{
  const view:View={tab:'library',title:'내용 검색',description:{query:'눈',force:false}};
  expect(pagePath(view,'ignored-cursor')).toBe(descriptionPath(view.description!));
  expect(viewKey(view)).not.toBe(viewKey({...view,description:{query:'눈',force:true}}));
  expect(viewKey(view)).not.toBe(viewKey({...view,description:{query:'비',force:false}}));
  expect(viewKey(view)).not.toBe(viewKey({tab:'library',title:'에셋'}));
});
it('shares one request per text and limit, keeps ready answers, and forgets failures and not-ready answers',async()=>{
  mocks.api.mockResolvedValue({ready:true,gated:false,items:[{id:'a'},{nope:1}]});
  const first=readDescription(endpoint,{query:'눈',force:false},7),second=readDescription(endpoint,{query:' 눈 ',force:false},7);
  expect(mocks.api).toHaveBeenCalledTimes(1);
  expect(await first).toEqual({ready:true,gated:false,items:[{id:'a'}]});expect(await second).toBe(await first);
  expect(cachedDescription(endpoint,{query:'눈',force:false},7)?.items).toHaveLength(1);
  expect(cachedDescription(endpoint,{query:'눈',force:false})).toBeUndefined(); // another limit is another answer
  expect(cachedDescription(endpoint,{query:'눈',force:true},7)).toBeUndefined();
  expect(mocks.api.mock.calls[0][5]).toBe(endpoint);

  mocks.api.mockResolvedValueOnce({ready:false,gated:false,items:[]});
  await readDescription(endpoint,{query:'비',force:false});
  expect(cachedDescription(endpoint,{query:'비',force:false})).toBeUndefined();
  mocks.api.mockRejectedValueOnce(new Error('offline'));
  await expect(readDescription(endpoint,{query:'강',force:false})).rejects.toThrow('offline');
  mocks.api.mockResolvedValueOnce({ready:true,gated:false,items:[]});
  await readDescription(endpoint,{query:'강',force:false});expect(mocks.api).toHaveBeenCalledTimes(4);
});
