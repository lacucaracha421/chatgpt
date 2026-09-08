import {describe,it,expect} from 'vitest';
import {DEFAULT_CATALOG_QUERY,catalogPath,catalogDetailPath,catalogTagQuery} from './catalogModel';
describe('catalog read identities',()=>{
  it('keeps query and cursor separate and preserves provider-qualified IDs',()=>{
    const first=new URL(catalogPath({...DEFAULT_CATALOG_QUERY,text:'작가 & 제목',revealBlocked:true},null),'https://example.invalid');
    expect(first.searchParams.get('text')).toBe('작가 & 제목');expect(first.searchParams.get('revealBlocked')).toBe('true');
    const next=new URL(catalogPath(DEFAULT_CATALOG_QUERY,'signed/+'),'https://example.invalid');expect([...next.searchParams.keys()]).toEqual(['cursor']);
    expect(catalogDetailPath({provider:'kHentai',providerWorkId:'42'},'version')).toContain('/works/kHentai/42?context=version');
  });
  it('quotes a tag value without turning it into an expression',()=>{expect(catalogTagQuery('artist','a" OR b\\')).toBe('artist:"a\\" OR b\\\\"');});
});
