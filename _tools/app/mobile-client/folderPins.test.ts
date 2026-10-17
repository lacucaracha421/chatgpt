import {beforeEach, expect, it, vi} from 'vitest';
const mocks = vi.hoisted(() => ({api: vi.fn()}));
vi.mock('./transport', () => ({api: mocks.api}));
import {addFolderPins, loadFolderPins, removeFolderPins, reorderFolderPins} from './folderPins';

beforeEach(() => mocks.api.mockReset());

it('reads the shared list', async () => {
  mocks.api.mockResolvedValue({version: 1, revision: 4, pinnedIds: ['a', 'b']});
  expect(await loadFolderPins()).toEqual({revision: 4, pinnedIds: ['a', 'b']});
  expect(mocks.api).toHaveBeenCalledWith('/v1/library/folder-pins', undefined);
});

it('sends add, remove and reorder as per-id commands and returns the merged list', async () => {
  mocks.api.mockResolvedValue({version: 1, revision: 5, pinnedIds: ['c', 'a', 'tablet']});
  expect(await addFolderPins(['a'])).toEqual({revision: 5, pinnedIds: ['c', 'a', 'tablet']});
  await removeFolderPins(['b']);
  await reorderFolderPins(['c', 'a']);
  expect(mocks.api.mock.calls.map(([path, , body, method]) => [path, body, method])).toEqual([
    ['/v1/library/folder-pins', {commands: [{op: 'add', ids: ['a']}]}, 'POST'],
    ['/v1/library/folder-pins', {commands: [{op: 'remove', ids: ['b']}]}, 'POST'],
    ['/v1/library/folder-pins', {commands: [{op: 'order', ids: ['c', 'a']}]}, 'POST'],
  ]);
});

it('refuses an answer from a server that does not know folder pins', async () => {
  mocks.api.mockResolvedValue({detail: 'Not Found'});
  await expect(loadFolderPins()).rejects.toThrow('고정한 폴더');
});
