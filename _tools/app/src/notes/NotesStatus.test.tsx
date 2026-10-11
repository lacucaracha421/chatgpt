import {cleanup,fireEvent,render,screen,waitFor,within} from '@testing-library/react';
import {afterEach,expect,it,vi} from 'vitest';
import {WorkspaceChromeProvider,ChromeTarget} from '../layout/WorkspaceChrome';
import userEvent from '@testing-library/user-event';
import {NotesWorkspace} from './NotesView';
import {NotesStore,type NotesRequest} from './store';

afterEach(cleanup);
it('keeps sync words out of the top bar and offers sync with its last time in the notes menu',async()=>{
  const lastSyncedAt='2026-10-11T03:45:00Z';
  const request=vi.fn(async()=>({unlocked:true,notes:[],lastSyncedAt}));
  const store=new NotesStore(request as NotesRequest);
  render(<WorkspaceChromeProvider scope="notes"><ChromeTarget name="navigation"/><ChromeTarget name="actions"/><ChromeTarget name="search"/><NotesWorkspace store={store}/></WorkspaceChromeProvider>);
  const view=await screen.findByRole('button',{name:/보기/});
  await waitFor(()=>expect(store.snapshot().lastSyncedAt).toBe(lastSyncedAt));
  expect(screen.queryByText('동기화됨')).toBeNull();expect(screen.queryByText('PC에 저장됨')).toBeNull();
  await userEvent.click(view);
  const time=new Date(lastSyncedAt).toLocaleTimeString('ko-KR',{hour:'2-digit',minute:'2-digit',hour12:false});
  const sync=within(screen.getByRole('menu')).getByRole('menuitem',{name:`지금 동기화 · ${time}`});
  const before=request.mock.calls.length;fireEvent.click(sync);
  await waitFor(()=>expect(request.mock.calls.length).toBeGreaterThan(before));
});
