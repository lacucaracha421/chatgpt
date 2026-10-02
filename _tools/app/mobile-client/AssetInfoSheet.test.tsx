import {cleanup,fireEvent,render,screen} from '@testing-library/react';
import {afterEach,expect,it,vi} from 'vitest';
import {readFileSync} from 'node:fs';
import {AssetInfoSheet} from './AssetInfoSheet';
import {ViewerInfo} from './ViewerInfo';
afterEach(()=>{cleanup();localStorage.clear();});
const asset={id:'one',kind:'image',width:600,height:800,creator_name:'작가',source_url:'https://example.com/post',preview:'blob:preview'};
it('uses exactly the viewer info content with a sheet close action',()=>{
 const close=vi.fn();const viewer=render(<ViewerInfo asset={asset}/>);
 const text=viewer.container.textContent;viewer.unmount();
 render(<AssetInfoSheet asset={asset} onClose={close}/>);
 expect(screen.getByLabelText('미디어 정보',{selector:'section'}).textContent).toBe(text);
 fireEvent.click(screen.getByRole('button',{name:'정보 닫기'}));expect(close).toHaveBeenCalledOnce();
});
it('uses portrait bottom and landscape side placement with scoped CSS',()=>{
 const css=readFileSync('mobile-client/AssetInfoSheet.css','utf8');
 expect(css).toContain('inset:auto 0 0');expect(css).toContain('@media (orientation:landscape)');
 expect(css).toContain('inset:0 0 0 auto');expect(css).toContain('.ui-dialog:has(> .asset-info-sheet)');
});
it('dismisses on a downward header swipe',()=>{
 const close=vi.fn();render(<AssetInfoSheet asset={asset} onClose={close}/>);
 const header=document.querySelector('.asset-info-sheet__header')!;
 fireEvent.pointerDown(header,{pointerId:1,clientX:100,clientY:20});
 fireEvent.pointerUp(header,{pointerId:1,clientX:105,clientY:120});
 expect(close).toHaveBeenCalledOnce();
});
