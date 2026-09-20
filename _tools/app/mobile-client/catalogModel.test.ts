import {describe,it,expect} from 'vitest';
import {DEFAULT_CATALOG_QUERY,CATALOG_PATH_MAX_BYTES,FILTER_JSON_MAX_BYTES,catalogFilterBytes,catalogPath,catalogPathIssue,catalogDetailPath,catalogReaderPath,catalogTagQuery,supportsDisplayPreferences,utf8Bytes,wireExcludedTags} from './catalogModel';
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
describe('catalog device filters',()=>{
  it('sends the user text byte-for-byte and adds no filter parameters by default',()=>{
    const path=catalogPath({...DEFAULT_CATALOG_QUERY,text:'작가 AND tag:"밤"'},null);
    expect(params(path).get('text')).toBe('작가 AND tag:"밤"');
    expect(params(path).has('categories')).toBe(false);expect(params(path).has('excludedTags')).toBe(false);expect(params(path).has('searchMode')).toBe(false);
    expect([...params(path).keys()]).toEqual(['provider','language','text','sort','scope','revealBlocked','limit']);
  });
  it('never rewrites the text when filters change',()=>{
    const base={...DEFAULT_CATALOG_QUERY,text:'artist:x AND tag:y'};
    expect(params(catalogPath({...base,categories:[3]},null)).get('text')).toBe('artist:x AND tag:y');
    expect(params(catalogPath({...base,categories:[3,6]},null)).get('text')).toBe('artist:x AND tag:y');
    expect(base.text).toBe('artist:x AND tag:y');
  });
  it('distinguishes no restriction, a multi-id selection, and an explicit empty selection',()=>{
    expect(params(catalogPath(DEFAULT_CATALOG_QUERY,null)).has('categories')).toBe(false);
    expect(params(catalogPath({...DEFAULT_CATALOG_QUERY,categories:[1,2,3]},null)).get('categories')).toBe('[1,2,3]');
    // The empty array stays on the wire: dropping it would widen back to unlimited.
    expect(params(catalogPath({...DEFAULT_CATALOG_QUERY,categories:[]},null)).get('categories')).toBe('[]');
    expect(catalogPath({...DEFAULT_CATALOG_QUERY,categories:[1]},null)).not.toBe(catalogPath({...DEFAULT_CATALOG_QUERY,categories:[2]},null));
    expect(catalogPath({...DEFAULT_CATALOG_QUERY,categories:[1]},null)).not.toBe(catalogPath(DEFAULT_CATALOG_QUERY,null));
  });
  it('sends exact namespace/value pairs and collapses duplicates',()=>{
    const path=catalogPath({...DEFAULT_CATALOG_QUERY,excludedTags:[{namespace:'female',value:'scat'}]},null);
    expect(JSON.parse(params(path).get('excludedTags')!)).toEqual([{namespace:'female',value:'scat'}]);
    expect(wireExcludedTags([{namespace:'artist',value:'foo'},{namespace:'artist',value:'foo'}])).toEqual([{namespace:'artist',value:'foo'}]);
    // Sorted so the frozen cursor identity is stable across devices.
    expect(wireExcludedTags([{namespace:'parody',value:'b'},{namespace:'artist',value:'a'}])).toEqual([{namespace:'artist',value:'a'},{namespace:'parody',value:'b'}]);
    // A namespaced entry is a tag lookup, never a title substring search.
    expect(params(catalogPath({...DEFAULT_CATALOG_QUERY,text:'',excludedTags:[{namespace:'female',value:'scat'}]},null)).get('text')).toBe('');
  });
  it('sends searchMode=mobile only when the caller has verified the capability',()=>{
    expect(params(catalogPath(DEFAULT_CATALOG_QUERY,null,{searchMode:false})).has('searchMode')).toBe(false);
    expect(params(catalogPath(DEFAULT_CATALOG_QUERY,null,{searchMode:true})).get('searchMode')).toBe('mobile');
  });
  it('keeps a cursor-only follow-up free of re-sent filters',()=>{
    const next=catalogPath({...DEFAULT_CATALOG_QUERY,categories:[1],excludedTags:[{namespace:'female',value:'scat'}]},'signed/+',{searchMode:true});
    expect([...params(next).keys()]).toEqual(['cursor']);
  });
});
describe('display preference capability',()=>{
  it('accepts only an advertised version at or above this client',()=>{
    expect(supportsDisplayPreferences({capabilities:{displayPreferencesVersion:1}})).toBe(true);
    expect(supportsDisplayPreferences({capabilities:{displayPreferencesVersion:2}})).toBe(true);
    expect(supportsDisplayPreferences({capabilities:{displayPreferencesVersion:0}})).toBe(false);
    expect(supportsDisplayPreferences({capabilities:{bookmarkWrite:true}})).toBe(false);
    expect(supportsDisplayPreferences({capabilities:{displayPreferencesVersion:'1'}})).toBe(false);
    expect(supportsDisplayPreferences({})).toBe(false);
    expect(supportsDisplayPreferences(null)).toBe(false);
    expect(supportsDisplayPreferences(undefined)).toBe(false);
  });
});
const manyTags=(count:number)=>{const value='x'.repeat(24);return Array.from({length:count},(_,i)=>({namespace:'artist',value:`${value}${i}`}));};
describe('catalog wire bounds',()=>{
  it('measures the combined encoded filter, not a per-field limit',()=>{
    expect(catalogFilterBytes(DEFAULT_CATALOG_QUERY)).toBe(0);
    expect(catalogFilterBytes({categories:[1,2,3],excludedTags:[]})).toBe(utf8Bytes('[1,2,3]'));
    const one={categories:null,excludedTags:[{namespace:'female',value:'scat'}]};
    expect(catalogFilterBytes(one)).toBe(utf8Bytes(JSON.stringify([{namespace:'female',value:'scat'}])));
    // Each tag is individually valid, but the set can still exceed the budget.
    expect(catalogFilterBytes({categories:[],excludedTags:manyTags(64)})).toBeGreaterThan(FILTER_JSON_MAX_BYTES);
  });
  it('reports an over-large filter instead of composing a rejected request',()=>{
    const over={...DEFAULT_CATALOG_QUERY,categories:[] as number[],excludedTags:manyTags(64)};
    expect(catalogPathIssue(over)).toBe('filterTooLarge');
    expect(catalogPathIssue({...DEFAULT_CATALOG_QUERY,excludedTags:[{namespace:'female',value:'scat'}]})).toBe('none');
  });
  it('reports a path the native transport would refuse, without throwing',()=>{
    // A valid filter plus a huge text can still overflow the request path bound.
    const long={...DEFAULT_CATALOG_QUERY,text:'x'.repeat(CATALOG_PATH_MAX_BYTES)};
    expect(()=>catalogPathIssue(long)).not.toThrow();
    expect(catalogPathIssue(long)).toBe('pathTooLong');
    expect(catalogFilterBytes(long)).toBe(0);
  });
});
