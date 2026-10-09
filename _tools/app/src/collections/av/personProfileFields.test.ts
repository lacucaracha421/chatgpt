import {expect, it} from 'vitest';
import {applyProfileChanges, profileExpected, profileToken, validateProfileExpected} from './personProfileFields';
it('preserves null-profile CAS and predicts default empty links after the first field override',()=>{
 const person={displayName:'배우',nameJa:null,profile:null,stashdbProfile:null,profileOverrides:{}};
 expect(profileExpected(person,{urls:[]})).toEqual({urls:{value:null,overridden:false}});
 const next=applyProfileChanges(person,{heightCm:160});expect(profileToken(next,'urls')).toEqual({value:[],overridden:false});
 expect(applyProfileChanges(next,{heightCm:{reset:true}}).profile).toBeNull();
});
it('resets an explicitly null name baseline instead of falling back to the manual Japanese name',()=>{
 const next=applyProfileChanges({displayName:'배우',nameJa:'手入力',profile:null,stashdbProfile:null,profileOverrides:{nameJa:'手入力'},profileBaseNames:{displayName:'배우',nameJa:null}},{nameJa:{reset:true}});
 expect(next.nameJa).toBeNull();
});
it('accepts legacy numeric tokens without normalizing and rejects malformed persisted tokens',()=>{
 expect(()=>validateProfileExpected({bandIn:33},{bandIn:{value:32.5,overridden:false}})).not.toThrow();
 expect(()=>validateProfileExpected({bandIn:33},{bandIn:{value:'32',overridden:false}})).toThrow();
});
