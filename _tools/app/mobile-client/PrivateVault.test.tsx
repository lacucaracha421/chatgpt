import {act,cleanup,fireEvent,render,screen,waitFor} from '@testing-library/react';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
// Radix dialog work is scheduled outside fireEvent; the viewer is a nested dialog.
(globalThis as {IS_REACT_ACT_ENVIRONMENT?: boolean}).IS_REACT_ACT_ENVIRONMENT = true;
const mocked=vi.hoisted(()=>({native:vi.fn(),media:{mediaTicket:vi.fn(),loadThumbnail:vi.fn(),prefetchThumbnails:vi.fn(),invalidateTicket:vi.fn(),decodeImage:vi.fn()},warm:vi.fn()}));
vi.mock('./transport',()=>({native:mocked.native,errorText:(e:Error)=>e.message}));
// The vault must never reach the library media client (tickets, thumbnail cache, prefetch, warming).
vi.mock('./media',()=>mocked.media);
vi.mock('./originalTicketWarm',()=>({warmOriginalTickets:mocked.warm}));
// jsdom has no layout; render every virtual row like GalleryTiles.test does.
vi.mock('@tanstack/react-virtual',()=>({observeElementRect:()=>{},useVirtualizer:({count,estimateSize}:{count:number;estimateSize(i:number):number})=>{
  const sizes=Array.from({length:count},(_,i)=>estimateSize(i));
  return {measure(){},getTotalSize:()=>sizes.reduce((a,b)=>a+b,0),getVirtualItems:()=>sizes.map((_size,index)=>({key:index,index,start:sizes.slice(0,index).reduce((a,b)=>a+b,0)}))};
}}));
import {PrivateVault,type VaultState} from './PrivateVault';

const locked:VaultState={epoch:1,selected:true,present:true,unlocked:false,message:'',items:[]};
const open:VaultState={...locked,epoch:2,unlocked:true,items:[
  {id:'image',title:'사용자 지정 제목',kind:'image',url:'https://app.lakomics.local/vault/abc/image',thumbnail:'https://app.lakomics.local/vault/abc/thumb'},
  {id:'video',title:'영상 제목',kind:'video',url:'https://app.lakomics.local/vault/abc/video',thumbnail:null},
  {id:'second',title:'두 번째 이미지',kind:'image',url:'https://app.lakomics.local/vault/abc/second',thumbnail:'https://app.lakomics.local/vault/abc/thumb2',width:1200,height:800},
]};
function emit(state:VaultState){act(()=>window.dispatchEvent(new CustomEvent('lakomics-vault',{detail:state})));}
function deferred<T>(){let resolve!:(value:T)=>void;const promise=new Promise<T>(yes=>{resolve=yes;});return{promise,resolve};}
beforeEach(()=>{
  vi.stubGlobal('ResizeObserver',class{observe(){}unobserve(){}disconnect(){}});
  for(const spy of Object.values(mocked.media))spy.mockReset();mocked.warm.mockReset();
  mocked.native.mockReset();
  mocked.native.mockImplementation(async(operation:string)=>operation==='vaultUnlock'?open:operation==='vaultLock'?{...locked,epoch:3}:locked);
});
afterEach(()=>{cleanup();vi.unstubAllGlobals();vi.restoreAllMocks();delete window.LakomicsNative;});
async function unlocked(){
  render(<PrivateVault onClose={vi.fn()} backRef={{current:null}}/>);
  fireEvent.change(await screen.findByLabelText('비밀번호'),{target:{value:'password'}});
  fireEvent.click(screen.getByRole('button',{name:'보관함 열기'}));
  await screen.findByRole('button',{name:'사용자 지정 제목 · 이미지'});
}
function libraryMediaUntouched(){
  for(const spy of Object.values(mocked.media))expect(spy).not.toHaveBeenCalled();
  expect(mocked.warm).not.toHaveBeenCalled();
}

it('waits for native secure-screen acknowledgement before showing a credential field',async()=>{
  const show=deferred<VaultState>();mocked.native.mockReturnValue(show.promise);
  render(<PrivateVault onClose={vi.fn()} backRef={{current:null}}/>);
  expect(screen.queryByLabelText('비밀번호')).toBeNull();
  expect(mocked.native).toHaveBeenCalledWith('vaultShow',{visible:true});
  await act(async()=>show.resolve(locked));
  expect(screen.getByLabelText('비밀번호')).toBeTruthy();
});

it('picks a USB without requiring cloud configuration',async()=>{
  mocked.native.mockResolvedValue({...locked,selected:false,present:false});
  render(<PrivateVault onClose={vi.fn()} backRef={{current:null}}/>);
  fireEvent.click(await screen.findByRole('button',{name:'USB 폴더 선택'}));
  await waitFor(()=>expect(mocked.native).toHaveBeenCalledWith('vaultPick'));
});

it('keeps secrets and metadata out of storage, shows custom thumbnails, and clears all media on lock',async()=>{
  const writes=vi.spyOn(Storage.prototype,'setItem');
  render(<PrivateVault onClose={vi.fn()} backRef={{current:null}}/>);
  fireEvent.change(await screen.findByLabelText('비밀번호'),{target:{value:'typed-password'}});
  fireEvent.click(screen.getByRole('button',{name:'보관함 열기'}));
  await screen.findByRole('button',{name:'사용자 지정 제목 · 이미지'});
  expect(mocked.native).toHaveBeenCalledWith('vaultUnlock',{secret:'typed-password',recovery:false},expect.any(AbortSignal));
  expect(document.querySelector('img')?.getAttribute('src')).toBe(open.items[0].thumbnail);
  fireEvent.click(screen.getByRole('button',{name:'사용자 지정 제목 · 이미지'}));
  expect((await screen.findByAltText('사용자 지정 제목')).getAttribute('src')).toBe(open.items[0].url);
  emit({...locked,epoch:3,message:'USB가 분리되어 잠겼습니다',present:false});
  expect(screen.queryByText('사용자 지정 제목')).toBeNull();
  expect(document.querySelector('img,video')).toBeNull();
  expect(screen.getByText('USB가 분리되어 잠겼습니다')).toBeTruthy();
  expect(writes).not.toHaveBeenCalled();
  expect(mocked.native.mock.calls.some(([op])=>['media','thumbnail','copyText','openExternal'].includes(op))).toBe(false);
});

it('discards a late unlock reply after an automatic lock and never auto-unlocks',async()=>{
  const unlock=deferred<VaultState>();
  mocked.native.mockImplementation(async(op:string)=>op==='vaultUnlock'?unlock.promise:locked);
  render(<PrivateVault onClose={vi.fn()} backRef={{current:null}}/>);
  fireEvent.change(await screen.findByLabelText('비밀번호'),{target:{value:'password'}});
  fireEvent.click(screen.getByRole('button',{name:'보관함 열기'}));
  emit({...locked,epoch:5,message:'화면이 꺼져 잠겼습니다'});
  await act(async()=>unlock.resolve(open));
  expect(screen.queryByText('사용자 지정 제목')).toBeNull();
  expect((screen.getByLabelText('비밀번호') as HTMLInputElement).value).toBe('');
  expect(mocked.native.mock.calls.filter(([op])=>op==='vaultUnlock')).toHaveLength(1);
});

it('uses recovery unlock, offers native video seeking, and consumes Back inside the viewer',async()=>{
  const backRef:{current:(()=>boolean)|null}={current:null};
  render(<PrivateVault onClose={vi.fn()} backRef={backRef}/>);
  fireEvent.click(await screen.findByRole('button',{name:'복구 키'}));
  fireEvent.change(screen.getByLabelText('복구 키'),{target:{value:'a'.repeat(64)}});
  fireEvent.click(screen.getByRole('button',{name:'보관함 열기'}));
  fireEvent.click(await screen.findByRole('button',{name:'영상 제목 · 영상'}));
  const video=document.querySelector('video')!;
  expect(video.controls).toBe(true);expect(video.getAttribute('src')).toBe(open.items[1].url);
  expect(video.getAttribute('controlsList')).toContain('nodownload');
  act(()=>expect(backRef.current?.()).toBe(true));
  expect(document.querySelector('video')).toBeNull();
  expect(backRef.current?.()).toBe(false);
  expect(mocked.native).toHaveBeenCalledWith('vaultUnlock',{secret:'a'.repeat(64),recovery:true},expect.any(AbortSignal));
});

it('hides media on pause and waits for current native state before displaying after resume',async()=>{
  mocked.native.mockResolvedValue(open);
  render(<PrivateVault onClose={vi.fn()} backRef={{current:null}}/>);
  await screen.findByRole('button',{name:'사용자 지정 제목 · 이미지'});
  act(()=>window.dispatchEvent(new Event('lakomics-pause')));
  expect(document.querySelector('img,video')).toBeNull();
  const refreshed=deferred<VaultState>();mocked.native.mockReturnValue(refreshed.promise);
  act(()=>window.dispatchEvent(new Event('lakomics-resume')));
  expect(document.querySelector('img,video')).toBeNull();
  await act(async()=>refreshed.resolve({...locked,epoch:3}));
  expect(await screen.findByLabelText('비밀번호')).toBeTruthy();
});

it('locks immediately and releases the secure screen when leaving',async()=>{
  const result=render(<PrivateVault onClose={vi.fn()} backRef={{current:null}}/>);
  await screen.findByLabelText('비밀번호');result.unmount();
  expect(mocked.native).toHaveBeenCalledWith('vaultLock');
  expect(mocked.native).toHaveBeenCalledWith('vaultShow',{visible:false});
});

it('shows the vault in the library grid and viewer with no library actions or media client',async()=>{
  const native=vi.fn();window.LakomicsNative={request:native,cancel:vi.fn()};
  await unlocked();
  expect(screen.getByLabelText('자산 목록')).toBeTruthy();
  expect(screen.getByRole('button',{name:'영상 제목 · 영상'}).querySelector('.video-mark')).toBeTruthy();
  fireEvent.click(screen.getByRole('button',{name:'사용자 지정 제목 · 이미지'}));
  const original=await screen.findByAltText('사용자 지정 제목');
  expect(screen.getByText('1 / 3')).toBeTruthy();
  // The thumbnail covers the surface until the original has loaded.
  expect(document.querySelector('.viewer-placeholder')?.getAttribute('src')).toBe(open.items[0].thumbnail);
  fireEvent.load(original);
  expect(document.querySelector('.viewer-placeholder')).toBeNull();
  for(const action of ['분류','앨범','미디어 정보','휴지통으로'])expect(screen.queryByRole('button',{name:action})).toBeNull();
  fireEvent.click(screen.getByRole('button',{name:'다음 자산'}));
  const video=document.querySelector('video')!;
  expect(video.getAttribute('src')).toBe(open.items[1].url);
  expect(video.getAttribute('controlsList')).toContain('nodownload');
  expect(video.hasAttribute('disablePictureInPicture')).toBe(true);
  libraryMediaUntouched();
  expect(native.mock.calls.some(([,op])=>op==='perfLog')).toBe(false);
});

it('filters by kind in memory, swipes through the filtered list, and resets the filter on lock',async()=>{
  const writes=vi.spyOn(Storage.prototype,'setItem');
  await unlocked();
  fireEvent.click(screen.getByRole('button',{name:'종류'}));
  expect(screen.getAllByRole('radio').map(option=>option.textContent)).toEqual(['전체','이미지','영상']);
  fireEvent.click(screen.getByRole('radio',{name:'영상'}));
  expect(screen.queryByRole('button',{name:'사용자 지정 제목 · 이미지'})).toBeNull();
  expect(screen.getByRole('button',{name:'영상 제목 · 영상'})).toBeTruthy();
  fireEvent.click(screen.getByRole('button',{name:'영상'}));
  fireEvent.click(screen.getByRole('radio',{name:'이미지'}));
  expect(screen.queryByRole('button',{name:'영상 제목 · 영상'})).toBeNull();
  fireEvent.click(screen.getByRole('button',{name:'사용자 지정 제목 · 이미지'}));
  await screen.findByAltText('사용자 지정 제목');
  expect(screen.getByText('1 / 2')).toBeTruthy();
  fireEvent.click(screen.getByRole('button',{name:'다음 자산'}));
  expect((await screen.findByAltText('두 번째 이미지')).getAttribute('src')).toBe(open.items[2].url);
  expect(document.querySelector('video')).toBeNull();
  emit({...locked,epoch:3});
  expect(document.querySelector('img,video')).toBeNull();
  mocked.native.mockImplementation(async(operation:string)=>operation==='vaultUnlock'?{...open,epoch:4}:{...locked,epoch:3});
  fireEvent.change(screen.getByLabelText('비밀번호'),{target:{value:'password'}});
  fireEvent.click(screen.getByRole('button',{name:'보관함 열기'}));
  expect(await screen.findByRole('button',{name:'영상 제목 · 영상'})).toBeTruthy();
  expect(screen.getByRole('button',{name:'종류'})).toBeTruthy();
  expect(writes).not.toHaveBeenCalled();
  libraryMediaUntouched();
});

it('reports the media element error class for a failed vault video without URLs',async()=>{
  const warn=vi.spyOn(console,'warn').mockImplementation(()=>{});
  await unlocked();
  fireEvent.click(screen.getByRole('button',{name:'영상 제목 · 영상'}));
  const video=document.querySelector('video')!;
  Object.defineProperty(video,'error',{value:{code:2,message:'PIPELINE_ERROR_READ: https://app.lakomics.local/vault/abc/video'}});
  fireEvent.error(video);
  const status=await screen.findByText(/영상을 재생하지 못했습니다/);
  expect(status.textContent).toContain('(오류 2 · PIPELINE_ERROR_READ)');
  expect(status.textContent).not.toContain('vault/');
  expect(warn.mock.calls.flat().join(' ')).not.toContain('vault/abc');
});
