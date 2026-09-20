import {describe,it,expect,beforeEach} from 'vitest';
import {DEFAULT_CATALOG_PREFERENCES,catalogPreferenceBytes,catalogPreferencesFit,catalogPreferencesKey,clearCatalogPreferences,parseCatalogPreferences,parseExcludedTagInput,readCatalogPreferences,validExcludedTag,writeCatalogPreferences,EXCLUDED_TAG_MAX} from './catalogPreferences';
import {FILTER_JSON_MAX_BYTES} from './catalogModel';
beforeEach(()=>localStorage.clear());
describe('catalog device preferences',()=>{
  it('treats a missing value as the unfiltered default',()=>{
    expect(readCatalogPreferences('https://a.invalid')).toEqual(DEFAULT_CATALOG_PREFERENCES);
  });
  it('round-trips categories and exact exclusions for one endpoint',()=>{
    writeCatalogPreferences('https://a.invalid',{categories:[2,1],excludedTags:[{namespace:'female',value:'scat'}]});
    expect(readCatalogPreferences('https://a.invalid')).toEqual({categories:[1,2],excludedTags:[{namespace:'female',value:'scat'}]});
  });
  it('keeps an explicit empty category selection meaningful',()=>{
    expect(parseCatalogPreferences(JSON.stringify({categories:[],excludedTags:[]}))).toEqual({categories:[],excludedTags:[]});
    expect(parseCatalogPreferences(JSON.stringify({categories:null,excludedTags:[]}))).toEqual({categories:null,excludedTags:[]});
  });
  it('never applies one server preferences to another',()=>{
    writeCatalogPreferences('https://a.invalid',{categories:[1],excludedTags:[{namespace:'artist',value:'foo'}]});
    expect(readCatalogPreferences('https://b.invalid')).toEqual(DEFAULT_CATALOG_PREFERENCES);
    expect(catalogPreferencesKey('https://a.invalid')).not.toBe(catalogPreferencesKey('https://b.invalid'));
    clearCatalogPreferences('https://a.invalid');
    expect(readCatalogPreferences('https://a.invalid')).toEqual(DEFAULT_CATALOG_PREFERENCES);
    expect(readCatalogPreferences('https://b.invalid')).toEqual(DEFAULT_CATALOG_PREFERENCES);
  });
  it('falls back to the default on corrupt storage instead of partly honoring it',()=>{
    for(const raw of ['not json','[1,2]','{"categories":"1"}','{"categories":[0]}','{"categories":[12]}','{"categories":[1.5]}','{"categories":[true]}','{"categories":[1],"excludedTags":"x"}','{"excludedTags":[{"namespace":"artist"}]}','{"excludedTags":[{"namespace":"Artist","value":"x"}]}','{"excludedTags":[{"namespace":"artist name","value":"x"}]}','{"excludedTags":[{"namespace":"artist","value":""}]}','{"excludedTags":[{"namespace":"artist","value":"line\nbreak"}]}','{"excludedTags":[{"namespace":"artist","value":"x"},{"namespace":"artist"}]}']){
      expect(parseCatalogPreferences(raw),raw).toEqual(DEFAULT_CATALOG_PREFERENCES);
    }
    localStorage.setItem(catalogPreferencesKey('https://a.invalid'),'{broken');
    expect(readCatalogPreferences('https://a.invalid')).toEqual(DEFAULT_CATALOG_PREFERENCES);
  });
  it('parses one namespaced input, splitting on the first colon only',()=>{
    expect(parseExcludedTagInput('female:scat')).toEqual({namespace:'female',value:'scat'});
    expect(parseExcludedTagInput(' female : scat ')).toEqual({namespace:'female',value:'scat'});
    // A later colon belongs to the value, which is compared as exact text.
    expect(parseExcludedTagInput('group:a:b')).toEqual({namespace:'group',value:'a:b'});
    expect(parseExcludedTagInput('female')).toBeNull();
    expect(parseExcludedTagInput(':scat')).toBeNull();
    expect(parseExcludedTagInput('female:')).toBeNull();
    expect(parseExcludedTagInput('')).toBeNull();
  });
  it('bounds the combined encoded filter, not just each tag',()=>{
    const many=Array.from({length:64},(_,i)=>({namespace:'artist',value:`${'x'.repeat(24)}${i}`}));
    expect(many.every(validExcludedTag)).toBe(true);
    expect(catalogPreferenceBytes({categories:[],excludedTags:many})).toBeGreaterThan(FILTER_JSON_MAX_BYTES);
    expect(catalogPreferencesFit({categories:[],excludedTags:many})).toBe(false);
    expect(catalogPreferencesFit({categories:[1],excludedTags:[{namespace:'female',value:'scat'}]})).toBe(true);
    // A stored set that no longer fits is unusable, so it degrades to the default.
    expect(parseCatalogPreferences(JSON.stringify({categories:[],excludedTags:many}))).toEqual(DEFAULT_CATALOG_PREFERENCES);
  });
  it('bounds the stored value the same way the server does',()=>{
    expect(validExcludedTag({namespace:'female',value:'scat'})).toBe(true);
    expect(validExcludedTag({namespace:'a'.repeat(32),value:'x'})).toBe(true);
    expect(validExcludedTag({namespace:'a'.repeat(33),value:'x'})).toBe(false);
    expect(validExcludedTag({namespace:'Female',value:'x'})).toBe(false);
    expect(validExcludedTag({namespace:'1artist',value:'x'})).toBe(false);
    // The 200 bound counts UTF-8 bytes, not characters (67 Hangul syllables = 201).
    expect(validExcludedTag({namespace:'artist',value:'가'.repeat(66)})).toBe(true);
    expect(validExcludedTag({namespace:'artist',value:'가'.repeat(67)})).toBe(false);
    expect(validExcludedTag({namespace:'artist',value:'x'.repeat(200)})).toBe(true);
    expect(parseCatalogPreferences(JSON.stringify({categories:null,excludedTags:Array.from({length:EXCLUDED_TAG_MAX+1},(_,i)=>({namespace:'artist',value:`v${i}`}))}))).toEqual(DEFAULT_CATALOG_PREFERENCES);
  });
});
