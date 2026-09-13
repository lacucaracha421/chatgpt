import {act,cleanup,fireEvent,render,screen} from '@testing-library/react';
import {afterEach,expect,it,vi} from 'vitest';
import {HeaderTools} from './HeaderTools';
import {ClassificationIndex} from './ClassificationIndex';
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
it('opens all Library assets without a classification and removes sidebar search',()=>{
  const select=vi.fn();render(<ClassificationIndex items={[]} view={{tab:'library',title:'최근 저장',classification:'previous'}} onSelect={select} collapsed={new Set()} setCollapsed={()=>{}}/>);
  expect(screen.queryByRole('textbox',{name:'분류 찾기'})).toBeNull();fireEvent.click(screen.getByRole('button',{name:'전체',exact:true}));expect(select).toHaveBeenCalledWith({tab:'library',title:'전체'});
});
