import {cleanup,fireEvent,render,screen,within} from '@testing-library/react';
import {afterEach,expect,it} from 'vitest';
import {MarkdownView} from '../src/shared/markdown/MarkdownView';
import {MarkdownHelpButton} from './MarkdownHelp';
afterEach(cleanup);
it('opens the Markdown cheat sheet as a bottom sheet and closes it',()=>{
 render(<MarkdownHelpButton/>);
 fireEvent.click(screen.getByRole('button',{name:'마크다운 도움말'}));
 const sheet=screen.getByRole('dialog',{name:'마크다운 도움말'});
 expect(sheet.querySelector(':scope > .library-sheet')).not.toBeNull();
 expect(Array.from(sheet.querySelectorAll('dt'),dt=>dt.firstChild?.textContent)).toEqual(['제목','굵게','기울임','목록','할 일','링크','인용','코드','줄바꿈']);
 expect(sheet.querySelector('.markdown-help__result strong')?.textContent).toBe('굵게');
 expect(sheet.querySelector('.markdown-help__result ol li')?.textContent).toBe('첫째');
 expect(within(sheet).getAllByRole('checkbox').length).toBe(2);
 fireEvent.click(within(sheet).getByRole('button',{name:'닫기'}));
 expect(screen.queryByRole('dialog')).toBeNull();
});
it('renders the shared Markdown module in the mobile build without injected markup',()=>{
 const {container}=render(<MarkdownView source={'- [ ] a\n<img src=x onerror=alert(1)> [x](javascript:alert(1))'}/>);
 expect(container.querySelector('img')).toBeNull();
 expect(container.querySelector('a')).toBeNull();
 expect(container.textContent).toContain('<img src=x onerror=alert(1)>');
});
