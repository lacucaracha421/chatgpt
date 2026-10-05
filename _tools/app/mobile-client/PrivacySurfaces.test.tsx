import {act,cleanup,fireEvent,render,screen,waitFor} from '@testing-library/react';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
const mocks=vi.hoisted(()=>({thumbnail:vi.fn(),ticket:vi.fn(),artwork:vi.fn()}));
vi.mock('./media',()=>({loadThumbnail:mocks.thumbnail}));
vi.mock('./catalogMedia',()=>({catalogImageTicket:mocks.ticket}));
vi.mock('./collectionArtwork',async importOriginal=>({...await importOriginal<object>(),artworkTicket:mocks.artwork}));
import {CoverGroup} from './CoverGroup';
import {CatalogCover} from './CatalogCover';
import {Artwork} from './Collections';
import {ViewerInfo} from './ViewerInfo';
import {usePrivacyMode} from './privacyMode';
let setPrivacy:(value:boolean)=>void;
function Preference(){[,setPrivacy]=usePrivacyMode();return null;}
beforeEach(()=>{localStorage.clear();vi.clearAllMocks();});
afterEach(()=>{cleanup();vi.unstubAllGlobals();});
const enable=()=>act(()=>setPrivacy(true));
const item={provider:'kHentai' as const,providerWorkId:'1',thumbnailUrl:'https://example.invalid/cover'};

it('masks folder, character and album covers without loading any thumbnail, including supplied previews',()=>{
 localStorage.setItem('lakomics.mobile.privacyMode','1');
 const {container}=render(<CoverGroup items={[{id:'cached',kind:'image',preview:'blob:cached'},{id:'uncached',kind:'image'}]} paused={false}/>);
 expect(container.querySelectorAll('.privacy-mask')).toHaveLength(2);
 expect(container.querySelector('img[src]')).toBeNull();
 expect(mocks.thumbnail).not.toHaveBeenCalled();
});
it('aborts a cover request and removes its existing preview when privacy turns on',()=>{
 mocks.thumbnail.mockImplementation(()=>new Promise(()=>{}));
 const {container}=render(<><Preference/><CoverGroup items={[{id:'cached',kind:'image',preview:'blob:cached'},{id:'pending',kind:'image'}]} paused={false}/></>);
 expect(container.querySelector('img')).toBeTruthy();
 const signal=mocks.thumbnail.mock.calls[0][1] as AbortSignal;
 enable();expect(signal.aborted).toBe(true);expect(container.querySelector('img[src]')).toBeNull();
});
it('masks every catalog cover use without a ticket and reports no cover URL',()=>{
 localStorage.setItem('lakomics.mobile.privacyMode','1');const onUrl=vi.fn();
 const {container}=render(<CatalogCover item={item} revision="r" active onUrl={onUrl}/>);
 expect(container.querySelector('.privacy-mask')).toBeTruthy();expect(container.querySelector('img[src]')).toBeNull();
 expect(mocks.ticket).not.toHaveBeenCalled();expect(onUrl).toHaveBeenLastCalledWith(null);
});
it('immediately removes a decoded catalog cover and clears its published URL',async()=>{
 vi.stubGlobal('IntersectionObserver',class{constructor(private callback:IntersectionObserverCallback){} observe(target:Element){this.callback([{target,isIntersecting:true} as IntersectionObserverEntry],this as unknown as IntersectionObserver);} unobserve(){} disconnect(){}});
 mocks.ticket.mockResolvedValue({url:'https://app.lakomics.local/media-cache/cover'});const onUrl=vi.fn();
 const {container}=render(<><Preference/><CatalogCover item={item} revision="r" active onUrl={onUrl}/></>);
 await waitFor(()=>expect(container.querySelector('img')).toBeTruthy());
 await act(async()=>fireEvent.load(container.querySelector('img')!));
 expect(container.querySelector('[data-catalog-decoded="true"]')).toBeTruthy();
 expect(onUrl).toHaveBeenLastCalledWith('https://app.lakomics.local/media-cache/cover');
 enable();expect(container.querySelector('img[src]')).toBeNull();expect(onUrl).toHaveBeenLastCalledWith(null);
});
it('masks collection artwork in seasons, release shelves and original cover surfaces without tickets',()=>{
 localStorage.setItem('lakomics.mobile.privacyMode','1');
 const {container}=render(<Artwork item={{id:'work',name:'작품',type:'manga',selectedWorkArtworkId:'art'}} id="art" revision="r" original/>);
 expect(container.querySelector('.privacy-mask')).toBeTruthy();expect(container.querySelector('img[src]')).toBeNull();expect(mocks.artwork).not.toHaveBeenCalled();
});
it('keeps list and viewer info readable while masking its supplied preview',()=>{
 localStorage.setItem('lakomics.mobile.privacyMode','1');
 const {container}=render(<ViewerInfo image asset={{id:'info',kind:'image',preview:'blob:preview',width:600,height:800}}/>);
 expect(screen.getByText('600 × 800')).toBeTruthy();expect(container.querySelector('.privacy-mask')).toBeTruthy();expect(container.querySelector('img[src]')).toBeNull();
});

it('NSFW masks each folder/album/home mosaic cell, including cached unknowns, without requesting media',()=>{
 localStorage.setItem('lakomics.mobile.nsfwFilter','1');
 const {container}=render(<CoverGroup paused={false} items={[
  {id:'g',kind:'image',contentRating:'g',preview:'blob:safe'},
  {id:'q',kind:'image',contentRating:'q',preview:'blob:unsafe'},
  {id:'unknown',kind:'image',preview:'blob:unknown'},
 ]}/>);
 expect(container.querySelectorAll('img[src]')).toHaveLength(1);
 expect(container.querySelector('img')?.getAttribute('src')).toBe('blob:safe');
 expect(container.querySelectorAll('.privacy-mask')).toHaveLength(2);
 expect(mocks.thumbnail).not.toHaveBeenCalled();
});
it('privacy wins over a g rating while both device switches are on',()=>{
 localStorage.setItem('lakomics.mobile.nsfwFilter','1');localStorage.setItem('lakomics.mobile.privacyMode','1');
 const {container}=render(<CoverGroup paused={false} items={[{id:'g',kind:'image',contentRating:'g',preview:'blob:safe'}]}/>);
 expect(container.querySelector('img[src]')).toBeNull();expect(mocks.thumbnail).not.toHaveBeenCalled();
});
