import {describe,it,expect} from 'vitest';
import {DEFAULT_CATALOG_QUERY,catalogPath,catalogWireText,catalogDetailPath,catalogReaderPath,catalogTagQuery} from './catalogModel';
const params=(path:string)=>new URL(path,'https://example.invalid').searchParams;
describe('catalog read identities',()=>{
  it('keeps query and cursor separate and preserves provider-qualified IDs',()=>{
    const first=params(catalogPath({...DEFAULT_CATALOG_QUERY,text:'작가 & 제목',revealBlocked:true},null));
    expect(first.get('text')).toBe('작가 & 제목');expect(first.get('revealBlocked')).toBe('true');
    const next=new URL(catalogPath(DEFAULT_CATALOG_QUERY,'signed/+'),'https://example.invalid');expect([...next.searchParams.keys()]).toEqual(['cursor']);
    expect(catalogDetailPath({provider:'kHentai',providerWorkId:'42'},'version')).toContain('/works/kHentai/42?context=version');expect(catalogReaderPath({provider:'kHentai',providerWorkId:'42'},'version')).toContain('/works/kHentai/42/reader?context=version');
  });
  it('quotes a tag value without turning it into an expression',()=>{expect(catalogTagQuery('artist','a" OR b\\')).toBe('artist:"a\\" OR b\\\\"');});
});
describe('catalog category filter',()=>{
  it('defaults to no restriction and leaves the text byte-for-byte',()=>{
    expect(DEFAULT_CATALOG_QUERY.category).toBeNull();
    expect(catalogWireText({text:'작가 AND tag:"밤"',category:null})).toBe('작가 AND tag:"밤"');
    expect(params(catalogPath({...DEFAULT_CATALOG_QUERY,text:'작가 AND tag:"밤"'},null)).get('text')).toBe('작가 AND tag:"밤"');
  });
  it('adds a category only to the wire text and never as a URL parameter',()=>{
    const path=catalogPath({...DEFAULT_CATALOG_QUERY,category:3},null);
    expect(params(path).get('text')).toBe('category:3');
        expect(catalogWireText({text:'  \n ',category:3})).toBe('category:3');
    expect(params(path).has('category')).toBe(false);
    expect([...params(path).keys()]).toEqual(['provider','language','text','sort','scope','revealBlocked','limit']);
  });
  it('parenthesises the user expression so boolean operators cannot bind across the category',()=>{
    expect(catalogWireText({text:'artist:x AND tag:y',category:3})).toBe('(artist:x AND tag:y) category:3');
    expect(catalogWireText({text:'a OR b',category:6})).toBe('(a OR b) category:6');
    expect(catalogWireText({text:'NOT tag:y',category:2})).toBe('(NOT tag:y) category:2');
    expect(catalogWireText({text:'artist:"a  b"',category:1})).toBe('(artist:"a  b") category:1');
  });
  it('keeps a typed category expression and the selector independent',()=>{
    // Selection adds its own term; the user's typed term is untouched, not merged.
    expect(catalogWireText({text:'category:artistcg AND tag:y',category:4})).toBe('(category:artistcg AND tag:y) category:4');
    // Clearing the selector restores exactly what the user typed.
    expect(catalogWireText({text:'category:artistcg AND tag:y',category:null})).toBe('category:artistcg AND tag:y');
    expect(catalogWireText({text:'NOT (category:3 OR category:4)',category:null})).toBe('NOT (category:3 OR category:4)');
  });
  it('changes only the wire text when the selection changes, preserving the draft text',()=>{
    const base={...DEFAULT_CATALOG_QUERY,text:'작가 태그'};
    expect(catalogWireText({...base,category:1})).toBe('(작가 태그) category:1');
    expect(catalogWireText({...base,category:9})).toBe('(작가 태그) category:9');
    expect(base.text).toBe('작가 태그');
  });
  it('keeps the category in the list cache identity',()=>{
    expect(catalogPath({...DEFAULT_CATALOG_QUERY,category:3},null)).not.toBe(catalogPath({...DEFAULT_CATALOG_QUERY,category:9},null));
    expect(catalogPath({...DEFAULT_CATALOG_QUERY,category:3},null)).not.toBe(catalogPath(DEFAULT_CATALOG_QUERY,null));
  });
});
