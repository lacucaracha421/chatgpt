import {useState,type ReactNode} from 'react';
import {fireEvent,render as rtlRender,screen,type RenderOptions} from '@testing-library/react';
import {FindContext,type ScreenFind} from './FindContext';
import {FindSheet} from './FindSheet';

export function FindTestHost({children}:{children:ReactNode}) {
  const [search,setSearch]=useState<ScreenFind>(),[open,setOpen]=useState(false);
  return <FindContext.Provider value={value=>{setSearch(value);setOpen(true);}}>{children}<FindSheet context={{tab:'collections'}} open={open} search={search} entries={[]} endpoint="screen-search-test" privacy={false} onClose={()=>setOpen(false)}/></FindContext.Provider>;
}
export const render=(ui:ReactNode,options?:RenderOptions)=>rtlRender(ui,{wrapper:FindTestHost,...options});
export function openScreenSearch() {
  fireEvent.click(screen.getByRole('button',{name:'찾기'}));
  fireEvent.keyDown(screen.getByRole('combobox',{name:'작품, 폴더·캐릭터, 태그, 작가, 메모 또는 메뉴 이름'}),{key:'Enter'});
}
