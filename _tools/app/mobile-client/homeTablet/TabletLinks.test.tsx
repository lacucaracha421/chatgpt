import {cleanup,fireEvent,render,screen,waitFor,within} from '@testing-library/react';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {TabletLinks} from './TabletLinks';
import {newLinksNote,parseLinks,serializeLinks} from '../../src/home/links';
import type {NotesStore} from '../../src/notes/store';

const clipboard=vi.hoisted(()=>vi.fn());
vi.mock('../ViewerInfo',()=>({writeClipboard:clipboard}));
const links=[{url:'https://a.example/',title:'사진',imageUrl:'https://img.example/a.jpg',savedAt:'2026-10-22T00:00:00Z'},{url:'https://b.example/',title:'글',savedAt:'2026-10-22T00:00:00Z'}];
beforeEach(()=>{localStorage.clear();clipboard.mockReset().mockResolvedValue(undefined);});
afterEach(cleanup);
function fixture(){
  let snapshot={ready:true,unlocked:true,notes:[newLinksNote(links)]};
  const edit=vi.fn(note=>{snapshot={...snapshot,notes:[note]};});
  const store={snapshot:()=>snapshot,subscribe:()=>()=>{},edit,finish:vi.fn(async()=>{})} as unknown as NotesStore;
  return {store,edit,replace:(changes:Record<string,unknown>)=>{snapshot={...snapshot,...changes};},snapshot:()=>snapshot};
}
it('filters image links and copies the URL through the tablet clipboard',async()=>{
  const f=fixture();render(<TabletLinks store={f.store} root="test" privacy={false} all onOpenNotes={vi.fn()}/>);
  fireEvent.click(screen.getByRole('radio',{name:/이미지 있음/}));
  expect(screen.queryByRole('button',{name:/글.*b.example/})).toBeNull();
  fireEvent.click(screen.getByRole('button',{name:'사진 복사'}));
  await waitFor(()=>expect(clipboard).toHaveBeenCalledWith(links[0].url));
  expect(f.edit).not.toHaveBeenCalled();
});
it('deletes from the latest note, preserving links added since rendering',()=>{
  const f=fixture();render(<TabletLinks store={f.store} root="test" privacy={false} all onOpenNotes={vi.fn()}/>);
  const note=f.snapshot().notes[0];
  f.replace({notes:[{...note,body:serializeLinks([...links,{...links[1],url:'https://new.example/',title:'새 링크'}])}]});
  const article=screen.getByRole('button',{name:/사진.*a.example/}).closest('article')!;
  fireEvent.click(within(article).getByRole('button',{name:'사진 삭제'}));
  expect(parseLinks(f.edit.mock.calls[0][0].body).map(link=>link.url)).toEqual(['https://b.example/','https://new.example/']);
});
it.each(['conflict','readOnly','concealed'])('rejects deletion when the latest note becomes %s',flag=>{
  const f=fixture();render(<TabletLinks store={f.store} root="test" privacy={false} all onOpenNotes={vi.fn()}/>);
  f.replace({notes:[{...f.snapshot().notes[0],[flag]:true}]});
  fireEvent.click(screen.getAllByRole('button',{name:/삭제/})[0]);
  expect(f.edit).not.toHaveBeenCalled();
});

it('fills a newly kept link with the server preview without replacing other edits',async()=>{
  const f=fixture();
  let resolve:(value:{title:string;siteName:string;imageUrl:string})=>void=()=>{};
  const previews={preview:vi.fn(()=>new Promise<{title:string;siteName:string;imageUrl:string}>(done=>{resolve=done;}))};
  render(<TabletLinks store={f.store} root="test" privacy={false} onOpenNotes={vi.fn()} previews={previews}/>);
  const input=screen.getByRole('textbox',{name:'URL 붙여넣기'});
  fireEvent.change(input,{target:{value:'https://new.example/post'}});
  fireEvent.submit(input.closest('form')!);
  expect(parseLinks(f.snapshot().notes[0].body)[0]).toMatchObject({url:'https://new.example/post',title:'new.example'});
  // Another device deletes a link while the preview is read.
  f.replace({notes:[{...f.snapshot().notes[0],body:serializeLinks(parseLinks(f.snapshot().notes[0].body).filter(link=>link.url!=='https://b.example/'))}]});
  await waitFor(()=>expect(previews.preview).toHaveBeenCalledWith('https://new.example/post'));
  resolve({title:'새 글',siteName:'예제',imageUrl:'https://new.example/cover.jpg'});
  await waitFor(()=>expect(parseLinks(f.snapshot().notes[0].body)[0]).toMatchObject({title:'새 글',siteName:'예제',imageUrl:'https://new.example/cover.jpg'}));
  expect(parseLinks(f.snapshot().notes[0].body).map(link=>link.url)).toEqual(['https://new.example/post','https://a.example/']);
  expect(previews.preview).toHaveBeenCalledTimes(1);
});
