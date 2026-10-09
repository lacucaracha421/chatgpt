import {describe, it, expect} from 'vitest';
import {performerName} from './performerName';
describe('shared performer display names', () => {
  it.each([
    [{displayName:'한국 이름', nameJa:'日本名', stashdbProfile:{name:'Roman Name'}}, {primary:'한국 이름', secondary:'日本名'}],
    [{displayName:'日本名', nameJa:'日本名', stashdbProfile:{name:'Roman Name'}}, {primary:'Roman Name', secondary:'日本名'}],
    [{name:'Legacy', nameJa:'日本名', profile:{name:'Mío Name'}}, {primary:'Mío Name', secondary:'日本名'}],
    [{displayName:'Legacy', nameJa:'Legacy', profile:{name:'日本名'}}, {primary:'Legacy', secondary:''}],
    [{displayName:'Legacy', nameJa:'日本名', stashdbProfile:{name:'日本名'}, profile:{name:'Roman Name'}}, {primary:'Roman Name', secondary:'日本名'}],
    [{displayName:'', nameJa:'日本名'}, {primary:'', secondary:'日本名'}],
  ])('resolves %j without writing names back', (person, expected) => {
    const original=JSON.stringify(person);expect(performerName(person)).toEqual(expected);expect(JSON.stringify(person)).toBe(original);
  });
});
