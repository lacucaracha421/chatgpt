import {expect,it} from 'vitest';
import {assetMasked} from './contentMask';
it.each([{media:{kind:'video'}},{kind:'video'},{mediaKind:'video'}])('masks safe-rated videos with known media kinds: %j',kind=>{
  expect(assetMasked(false,true,{contentRating:'g',...kind})).toBe(true);
  expect(assetMasked(false,false,{contentRating:'g',...kind})).toBe(false);
});
it('reveals only g images and always respects privacy',()=>{
  expect(assetMasked(false,true,{contentRating:'g',media:{kind:'image'}})).toBe(false);
  for(const contentRating of ['s','q','e',null,undefined] as const)expect(assetMasked(false,true,{contentRating})).toBe(true);
  expect(assetMasked(true,false,{contentRating:'g'})).toBe(true);
});
