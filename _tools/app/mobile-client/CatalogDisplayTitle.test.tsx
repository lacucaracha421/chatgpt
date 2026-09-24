import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {cleanup,fireEvent,render,screen} from '@testing-library/react';
import {Catalog} from './Catalog';
import type {CatalogItem,CatalogPage} from './catalogModel';
const mocks=vi.hoisted(()=>({api:vi.fn(),native:vi.fn()}));
vi.mock('./media',()=>({decodeImage:vi.fn()}));
vi.mock('./transport',()=>({api:mocks.api,native:mocks.native,errorText:(e:Error)=>e.message}));
// A provider title with a circle label, a Japanese original and a Korean translation.
const RAW='[서클 (작가)] 夜の図書館 | 밤의 도서관 [Korean]';
const item:CatalogItem={provider:'kHentai',providerWorkId:'42',groupId:'group',title:RAW,titleJpn:null,thumbnailUrl:null,artists:['작가'],series:[],fileCount:40,views:1200,posted:1000,bookmarked:false,versionCount:1,hasBookmarkedVersion:false};
const page:CatalogPage={ready:true,publicationRevision:'p1',publishedAt:null,items:[item],nextCursor:null,context:'context',countToken:null,totalCount:1,countStatus:'ready'};
beforeEach(()=>{
  localStorage.clear();mocks.native.mockResolvedValue({url:'data:image/gif;base64,R0lGODlhAQABAAAAACw='});
  mocks.api.mockImplementation(async(path:string)=>{
    if(path.includes('/status'))return {publicationRevision:'p1',capabilities:{bookmarkWrite:false,displayPreferencesVersion:1}};
    if(path.includes('/works/'))return {publicationRevision:'p1',item:{...item,tagGroups:[],uploader:null,category:1,updated:null,fileSize:null,rating:null}};
    if(path.includes('/editions?'))return {publicationRevision:'p1',groupId:'group',selectedProviderWorkId:null,items:[item],nextCursor:null,totalCount:1};
    return page;
  });
});
afterEach(cleanup);

it('shows the PC display title on cards and in the detail, keeping the original title and the search untouched',async()=>{
  render(<Catalog active paused={false} backRef={{current:null}}/>);
  const card=await screen.findByText('밤의 도서관');
  expect(screen.queryByText(RAW)).toBeNull();
  expect(card.getAttribute('aria-description')).toBe(RAW);
  fireEvent.click(card.closest('button')!);
  expect((await screen.findByRole('heading',{level:2})).textContent).toBe('밤의 도서관');
  // The provider title stays readable in the detail, as the PC keeps it under 원제.
  expect(screen.getByText(RAW)).toBeTruthy();
  // Only presentation changes: every request still carries the provider identity, never the display title.
  expect(mocks.api.mock.calls.some(([path])=>String(path).includes(encodeURIComponent('밤의 도서관')))).toBe(false);
});
