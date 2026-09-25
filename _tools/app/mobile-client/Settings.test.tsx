import {cleanup, fireEvent, render, screen} from '@testing-library/react';
import {afterEach, beforeEach, expect, it, vi} from 'vitest';
const mocks=vi.hoisted(()=>({native:vi.fn(),errors:vi.fn()}));
vi.mock('./transport',()=>({native:mocks.native,errorText:(reason:unknown)=>mocks.errors(reason) as string}));
// The picker section polls its own operation; it is not what these checks are about.
vi.mock('./PickerSettings',()=>({PickerSettings:()=>(<section aria-label="다른 앱에서 첨부하기"><h3>다른 앱에서 첨부하기</h3></section>)}));
import {Settings} from './Settings';
beforeEach(()=>{
  mocks.native.mockReset(); mocks.errors.mockReset(); mocks.errors.mockReturnValue('연결을 확인한 뒤 다시 시도해 주세요.');
  mocks.native.mockImplementation(async(op:string)=>({bytes:op==='clearCache'?0:2*1024*1024,count:op==='clearCache'?0:12,limit:1024*1024*1024}));
});
afterEach(cleanup);

it('shows device cache usage and clears only through its own action',async()=>{
  const cleared=vi.fn();
  render(<Settings status={{configured:true,endpoint:'https://example.invalid'}} onStatus={vi.fn()} onClose={vi.fn()} onCacheCleared={cleared}/>);
  await screen.findByText('2.0 MB / 1 GB · 12개');
  expect(cleared).not.toHaveBeenCalled();fireEvent.click(screen.getByRole('button',{name:'캐시 지우기'}));
  await screen.findByText('0.0 MB / 1 GB · 0개');expect(cleared).toHaveBeenCalledOnce();
});

it('keeps the connection editor collapsed while already connected',async()=>{
  render(<Settings status={{configured:true,endpoint:'https://example.invalid'}} onStatus={vi.fn()} onClose={vi.fn()} onCacheCleared={vi.fn()}/>);
  // The connected device shows the current address instead of a giant form.
  expect(screen.getByText('클라우드 연결됨')).toBeTruthy();
  expect(screen.getByText('https://example.invalid')).toBeTruthy();
  expect(screen.queryByLabelText('서버 주소')).toBeNull();
  expect(screen.queryByLabelText('기기 토큰')).toBeNull();
  fireEvent.click(screen.getByRole('button',{name:'연결 변경'}));
  expect(screen.getByLabelText('서버 주소')).toBeTruthy();
  expect(screen.getByLabelText('기기 토큰')).toBeTruthy();
});

it('opens the connection form directly when the device is not connected',async()=>{
  render(<Settings status={{configured:false,endpoint:''}} onStatus={vi.fn()} onClose={vi.fn()} onCacheCleared={vi.fn()}/>);
  expect(screen.getByText('연결되지 않음')).toBeTruthy();
  expect(screen.getByLabelText('서버 주소')).toBeTruthy();
  // Disconnect is only offered for an existing connection.
  expect(screen.queryByRole('button',{name:'연결 해제'})).toBeNull();
});

it('keeps private-HTTP validation and its explanation on the editor',async()=>{
  render(<Settings status={{configured:false,endpoint:''}} onStatus={vi.fn()} onClose={vi.fn()} onCacheCleared={vi.fn()}/>);
  const privateHttp=screen.getByLabelText('개인 네트워크의 HTTP 연결 허용');
  expect(screen.queryByText(/일반 인터넷 주소는 HTTPS가 필요합니다/)).toBeNull();
  fireEvent.click(privateHttp);
  expect(screen.getByText(/일반 인터넷 주소는 HTTPS가 필요합니다/)).toBeTruthy();
});

it('passes the entered values, including the private-HTTP option, to the native configure command',async()=>{
  const onStatus=vi.fn(), onClose=vi.fn();
  mocks.native.mockImplementation(async(op:string)=>op==='configure'?{configured:true,endpoint:'https://new.invalid',allowPrivateHttp:true}:{bytes:0,count:0,limit:1024});
  render(<Settings status={{configured:true,endpoint:'https://old.invalid'}} onStatus={onStatus} onClose={onClose} onCacheCleared={vi.fn()}/>);
  fireEvent.click(screen.getByRole('button',{name:'연결 변경'}));
  fireEvent.change(screen.getByLabelText('서버 주소'),{target:{value:'https://new.invalid'}});
  fireEvent.change(screen.getByLabelText('기기 토큰'),{target:{value:'token-value'}});
  fireEvent.click(screen.getByLabelText('개인 네트워크의 HTTP 연결 허용'));
  fireEvent.click(screen.getByRole('button',{name:'연결 확인하고 저장'}));
  await screen.findByText('클라우드 연결됨');
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

it('tucks the cache and connection recovery detail behind a disclosure',async()=>{
  render(<Settings status={{configured:true,endpoint:'https://example.invalid'}} onStatus={vi.fn()} onClose={vi.fn()} onCacheCleared={vi.fn()}/>);
  // Radix renders the dialog in a portal, so the disclosure is found in the document.
  const details=document.querySelector('details.settings-advanced')!;
  expect(details.hasAttribute('open')).toBe(false);
  expect(details.querySelector('summary')!.textContent).toBe('연결·캐시 동작 자세히');
  // Distinguishing the cache clear from the connection reset stays documented rather than implied.
  expect(details.textContent).toContain('서버의 원본과 연결 정보');
  expect(details.textContent).toContain('연결 해제');
});

it('reports the declared Android source version rather than a stale literal',async()=>{
  render(<Settings status={{configured:true,endpoint:'https://example.invalid'}} onStatus={vi.fn()} onClose={vi.fn()} onCacheCleared={vi.fn()}/>);
  expect(document.querySelector('.settings-foot')!.textContent).toContain('0.8.19 · Android');
});

it('opens the USB private vault even without a cloud connection',async()=>{
  const openVault=vi.fn();
  render(<Settings status={{configured:false,endpoint:''}} onStatus={vi.fn()} onClose={vi.fn()} onCacheCleared={vi.fn()} onOpenVault={openVault}/>);
  fireEvent.click(screen.getByRole('button',{name:'비밀 보관함'}));
  expect(openVault).toHaveBeenCalledOnce();
  await screen.findByText('2.0 MB / 1 GB · 12개');
});
