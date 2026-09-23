import {act,cleanup,fireEvent,render,screen} from '@testing-library/react';
import {afterEach,expect,it,vi} from 'vitest';
import {HeaderTools} from './HeaderTools';
import {ALL_ASSETS,isAll} from './libraryModel';
afterEach(()=>{cleanup();vi.unstubAllGlobals();});
it('moves one interactive toolbar between portrait content and landscape header',()=>{
  let changed=()=>{};const media={matches:false,addEventListener:(_:string,fn:()=>void)=>{changed=fn;},removeEventListener:vi.fn()};
  vi.stubGlobal('matchMedia',()=>media);const clicked=vi.fn();
  const {rerender}=render(<><header id="context-location"/><main><HeaderTools active target="context-location" landscapeOnly><button onClick={clicked}>도구</button></HeaderTools></main></>);
  expect(screen.getByRole('button').closest('main')).not.toBeNull();
  act(()=>{media.matches=true;changed();});expect(screen.getAllByRole('button')).toHaveLength(1);expect(screen.getByRole('button').closest('header')).not.toBeNull();fireEvent.click(screen.getByRole('button'));expect(clicked).toHaveBeenCalledOnce();
  act(()=>{media.matches=false;changed();});expect(screen.getByRole('button').closest('main')).not.toBeNull();
  rerender(<><header id="context-location"/><main><HeaderTools active={false} target="context-location" landscapeOnly><button>도구</button></HeaderTools></main></>);expect(screen.queryByRole('button')).toBeNull();
});
it('identifies All independently of the root and character scopes',()=>{
  expect(isAll(ALL_ASSETS)).toBe(true);
  expect(isAll({tab:'library',root:true,title:'라이브러리'})).toBe(false);
  expect(isAll({tab:'library',characters:true,title:'시리즈'})).toBe(false);
});
