import {readFileSync} from 'node:fs';
import {cleanup, fireEvent, render, screen} from '@testing-library/react';
import {afterEach, beforeEach, expect, it, vi} from 'vitest';
const mocks=vi.hoisted(()=>({native:vi.fn(),errors:vi.fn()}));
vi.mock('./transport',()=>({native:mocks.native,errorText:(reason:unknown)=>mocks.errors(reason) as string}));
import {Settings} from './Settings';
beforeEach(()=>{
  mocks.native.mockReset(); mocks.errors.mockReset(); mocks.errors.mockReturnValue('연결을 확인한 뒤 다시 시도해 주세요.');
  mocks.native.mockImplementation(async(op:string)=>({bytes:op==='clearCache'?0:2*1024*1024,count:op==='clearCache'?0:12,limit:1024*1024*1024}));
});
afterEach(cleanup);

it('shows device cache usage and clears only through its own action',async()=>{
  const cleared=vi.fn();
  render(<Settings status={{configured:true,endpoint:'https://example.invalid'}} onStatus={vi.fn()} onClose={vi.fn()} onCacheCleared={cleared}/>);
  expect(screen.getByRole('heading',{name:'설정'})).toBeTruthy();
  expect(screen.queryByRole('dialog')).toBeNull();
  await screen.findByText('2.0 MB / 1 GB · 12개');
  expect(cleared).not.toHaveBeenCalled();fireEvent.click(screen.getByRole('button',{name:'캐시 지우기'}));
  await screen.findByText('0.0 MB / 1 GB · 0개');expect(cleared).toHaveBeenCalledOnce();
});

it('keeps the connection editor collapsed while already connected',async()=>{
  render(<Settings status={{configured:true,endpoint:'https://example.invalid'}} onStatus={vi.fn()} onClose={vi.fn()} onCacheCleared={vi.fn()}/>);
  // The connected device shows the current address instead of a giant form.
  expect(screen.getByText('연결됨')).toBeTruthy();
  expect(screen.getByText('https://example.invalid')).toBeTruthy();
  expect(screen.queryByLabelText('서버 주소')).toBeNull();
  expect(screen.queryByLabelText('기기 토큰')).toBeNull();
  fireEvent.click(screen.getByRole('button',{name:'연결 변경'}));
  expect(screen.getByLabelText('서버 주소')).toBeTruthy();
  expect(screen.getByLabelText('기기 토큰')).toBeTruthy();
});

it('opens the connection form directly when the device is not connected',async()=>{
  render(<Settings status={{configured:false,endpoint:''}} onStatus={vi.fn()} onClose={vi.fn()} onCacheCleared={vi.fn()}/>);
  expect(screen.getByText('연결 안 됨')).toBeTruthy();
  expect(screen.getByLabelText('서버 주소')).toBeTruthy();
  // Disconnect is only offered for an existing connection.
  expect(screen.queryByRole('button',{name:'연결 해제'})).toBeNull();
});

it('keeps private-HTTP validation and its explanation on the editor',async()=>{
  render(<Settings status={{configured:false,endpoint:''}} onStatus={vi.fn()} onClose={vi.fn()} onCacheCleared={vi.fn()}/>);
  const privateHttp=screen.getByLabelText('개인 네트워크 HTTP 허용');
  expect(screen.queryByText(/숫자 IP\(Tailscale·내부망\)에만 사용/)).toBeNull();
  fireEvent.click(privateHttp);
  expect(screen.getByText(/숫자 IP\(Tailscale·내부망\)에만 사용/)).toBeTruthy();
});

it('stores the tablet privacy mode locally and exposes the switch to later private tabs',async()=>{
  render(<Settings status={{configured:true,endpoint:'https://example.invalid'}} onStatus={vi.fn()} onClose={vi.fn()} onCacheCleared={vi.fn()}/>);
  const privacy=screen.getByRole('switch',{name:'비공개 모드'});
  expect((privacy as HTMLInputElement).checked).toBe(false);
  fireEvent.click(privacy);
  expect((privacy as HTMLInputElement).checked).toBe(true);
  expect(localStorage.getItem('lakomics.mobile.privacyMode')).toBe('1');
});

it('passes the entered values, including the private-HTTP option, to the native configure command',async()=>{
  const onStatus=vi.fn(), onClose=vi.fn();
  mocks.native.mockImplementation(async(op:string)=>op==='configure'?{configured:true,endpoint:'https://new.invalid',allowPrivateHttp:true}:{bytes:0,count:0,limit:1024});
  render(<Settings status={{configured:true,endpoint:'https://old.invalid'}} onStatus={onStatus} onClose={onClose} onCacheCleared={vi.fn()}/>);
  fireEvent.click(screen.getByRole('button',{name:'연결 변경'}));
  fireEvent.change(screen.getByLabelText('서버 주소'),{target:{value:'https://new.invalid'}});
  fireEvent.change(screen.getByLabelText('기기 토큰'),{target:{value:'token-value'}});
  fireEvent.click(screen.getByLabelText('개인 네트워크 HTTP 허용'));
  fireEvent.click(screen.getByRole('button',{name:'연결 확인하고 저장'}));
  await screen.findByText('연결됨');
  expect(mocks.native).toHaveBeenCalledWith('configure',{endpoint:'https://new.invalid',token:'token-value',allowPrivateHttp:true});
  expect(onStatus).toHaveBeenCalledWith({configured:true,endpoint:'https://new.invalid',allowPrivateHttp:true});
});

it('shows a failed connection attempt without closing and keeps the entered address',async()=>{
  const onStatus=vi.fn(), onClose=vi.fn();
  mocks.native.mockImplementation(async(op:string)=>{if(op==='configure')throw new Error('tls');return {bytes:0,count:0,limit:1024};});
  render(<Settings status={{configured:false,endpoint:''}} onStatus={onStatus} onClose={onClose} onCacheCleared={vi.fn()}/>);
  fireEvent.change(screen.getByLabelText('서버 주소'),{target:{value:'https://draft.invalid'}});
  fireEvent.change(screen.getByLabelText('기기 토큰'),{target:{value:'t'}});
  fireEvent.click(screen.getByRole('button',{name:'연결 확인하고 저장'}));
  await screen.findByText('연결을 확인한 뒤 다시 시도해 주세요.');
  expect(onStatus).not.toHaveBeenCalled(); expect(onClose).not.toHaveBeenCalled();
  expect(screen.getByLabelText('서버 주소')).toHaveProperty('value','https://draft.invalid');
});

it('reports the declared Android source version rather than a stale literal',async()=>{
  render(<Settings status={{configured:true,endpoint:'https://example.invalid'}} onStatus={vi.fn()} onClose={vi.fn()} onCacheCleared={vi.fn()}/>);
  const declared = /android:versionName="([^"]+)"/.exec(readFileSync(`${process.cwd()}/../../android/AndroidManifest.xml`, 'utf8'))?.[1];
  expect(screen.getByText(`${declared} · Android`)).toBeTruthy();
});

it('opens the USB private vault even without a cloud connection',async()=>{
  const openVault=vi.fn();
  render(<Settings status={{configured:false,endpoint:''}} onStatus={vi.fn()} onClose={vi.fn()} onCacheCleared={vi.fn()} onOpenVault={openVault}/>);
  fireEvent.click(screen.getByRole('button',{name:'연결'}));
  expect(openVault).toHaveBeenCalledOnce();
  await screen.findByText('2.0 MB / 1 GB · 12개');
});

it('persists the independent tablet NSFW switch without changing privacy',()=>{
 localStorage.clear();
 render(<Settings status={{configured:false,endpoint:''}} onStatus={vi.fn()} onClose={vi.fn()} onCacheCleared={vi.fn()}/>);
 fireEvent.click(screen.getByRole('switch',{name:'NSFW 필터'}));
 expect(localStorage.getItem('lakomics.mobile.nsfwFilter')).toBe('1');
 expect(localStorage.getItem('lakomics.mobile.privacyMode')).not.toBe('1');
});

it('turns the shared case sounds off and on from 화면, on by default',()=>{
 localStorage.clear();
 render(<Settings status={{configured:false,endpoint:''}} onStatus={vi.fn()} onClose={vi.fn()} onCacheCleared={vi.fn()}/>);
 const toggle=screen.getByRole('switch',{name:'케이스 소리'}) as HTMLInputElement;
 expect(toggle.checked).toBe(true);
 fireEvent.click(toggle);
 expect(toggle.checked).toBe(false);
 expect(localStorage.getItem('lakomics.caseSounds')).toBe('0');
});

it('keeps 글자 크기 on this device through the app and hides it on a build without the setting',async()=>{
  const setTextZoom=vi.fn(()=>true);
  window.LakomicsNative={request:vi.fn(),cancel:vi.fn(),textZoom:()=>110,setTextZoom};
  try {
    const view=render(<Settings status={{configured:true,endpoint:'https://example.invalid'}} onStatus={vi.fn()} onClose={vi.fn()} onCacheCleared={vi.fn()}/>);
    expect(screen.getByRole('radio',{name:'110%'}).getAttribute('aria-checked')).toBe('true');
    fireEvent.click(screen.getByRole('radio',{name:'125%'}));
    expect(setTextZoom).toHaveBeenCalledWith(125);
    expect(screen.getByRole('radio',{name:'125%'}).getAttribute('aria-checked')).toBe('true');
    // A refused choice keeps the saved size and says so.
    setTextZoom.mockReturnValueOnce(false);fireEvent.click(screen.getByRole('radio',{name:'시스템'}));
    expect(screen.getByRole('radio',{name:'125%'}).getAttribute('aria-checked')).toBe('true');
    expect(screen.getByText('바꾸지 못했습니다. 다시 시도해 주세요.')).toBeTruthy();
    view.unmount();
    window.LakomicsNative={request:vi.fn(),cancel:vi.fn()};
    render(<Settings status={{configured:true,endpoint:'https://example.invalid'}} onStatus={vi.fn()} onClose={vi.fn()} onCacheCleared={vi.fn()}/>);
    expect(screen.queryByText('글자 크기')).toBeNull();
  } finally {delete window.LakomicsNative;}
});

it('brings the group a 찾기 pick names into view, at once on open and again for a later pick',()=>{
  const scrolled:{group:string|null;behavior?:ScrollBehavior}[]=[];
  // jsdom has no scrolling; record which group was asked to come into view.
  Element.prototype.scrollIntoView=function(this:Element,options?:boolean|ScrollIntoViewOptions){scrolled.push({group:this.getAttribute('aria-labelledby'),behavior:typeof options==='object'?options.behavior:undefined});};
  const props={status:{configured:true,endpoint:'https://example.invalid'},onStatus:vi.fn(),onClose:vi.fn(),onCacheCleared:vi.fn()};
  const view=render(<Settings {...props} section={{id:'storage',request:1}}/>);
  expect(scrolled).toEqual([{group:'settings-group-저장 공간',behavior:'auto'}]);
  view.rerender(<Settings {...props} section={{id:'display',request:2}}/>);
  expect(scrolled.at(-1)?.group).toBe('settings-group-화면');
  delete (Element.prototype as Partial<Element>).scrollIntoView;
});
