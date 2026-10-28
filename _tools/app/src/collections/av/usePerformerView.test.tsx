import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, expect, it } from 'vitest';
import { usePerformerView } from './usePerformerView';

afterEach(()=>{cleanup();localStorage.clear();});
it('remembers the view per library across switching and remounting, with separate tablet density',()=>{
  const {result,rerender,unmount}=renderHook(({library})=>usePerformerView(library),{initialProps:{library:'first'}});
  expect(result.current[0]).toMatchObject({view:'works',sort:'count',direction:'desc',columns:6});
  act(()=>result.current[1]({view:'performers',sort:'cup',columns:8}));
  rerender({library:'second'});
  expect(result.current[0]).toMatchObject({view:'works',sort:'count',columns:6});
  act(()=>result.current[1]({view:'performers',sort:'height'}));
  rerender({library:'first'});
  expect(result.current[0]).toMatchObject({view:'performers',sort:'cup',columns:8});
  unmount();
  const reopened=renderHook(()=>usePerformerView('first'));
  expect(reopened.result.current[0]).toMatchObject({view:'performers',sort:'cup',columns:8});
  const tablet=renderHook(()=>usePerformerView('first',true));
  expect(tablet.result.current[0]).toMatchObject({view:'works',columns:3});
});
