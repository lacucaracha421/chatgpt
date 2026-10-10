import {api, errorText} from './transport';

/** The classification authority identity the server reports with its folder list. */
export type FolderAuthority = {libraryId: string; epoch: number; contractVersion: number};
export type AuthorityFolder = {id: string; kind: 'root'|'work'|'tag'; name: string; parentId: string|null; iconKey: string|null; colorKey: string|null; deleted: boolean; entityRevision: number};
type Baseline = {libraryId: string; epoch: number; snapshotCursor: number; section: string; items: AuthorityFolder[]; hasMore: boolean; nextAfter: string|null};
type CommandReply = {classification: AuthorityFolder|null};

/** The tablet may create and rename folders; move and delete stay with the PC. */
export const FOLDER_NAME_LIMIT = 200;

/**
 * Every live folder with its entity revision, pinned to one authority snapshot.
 *
 * A rename presents the revision it read, so a folder someone else changed in the meantime is
 * answered with a conflict instead of being overwritten. Only the folder section is read.
 */
export async function readFolderSnapshot(authority: FolderAuthority, signal?: AbortSignal): Promise<AuthorityFolder[]> {
  const folders: AuthorityFolder[] = [];
  let after: string|null = null, snapshot: number|undefined;
  do {
    const path: string = `/v1/classifications/authority/baseline?libraryId=${encodeURIComponent(authority.libraryId)}&epoch=${authority.epoch}&limit=1000${snapshot === undefined ? '' : `&snapshot=${snapshot}&section=classifications`}${after ? `&after=${encodeURIComponent(after)}` : ''}`;
    const page: Baseline = await api<Baseline>(path, signal);
    if (page.libraryId !== authority.libraryId || page.epoch !== authority.epoch || page.section !== 'classifications' || !Array.isArray(page.items) || !Number.isInteger(page.snapshotCursor)) throw new Error('폴더 목록을 다시 불러와 주세요.');
    if (snapshot !== undefined && snapshot !== page.snapshotCursor) throw new Error('폴더 목록이 변경되었습니다. 다시 시도해 주세요.');
    snapshot = page.snapshotCursor;
    folders.push(...page.items);
    if (page.hasMore && (!page.nextAfter || page.nextAfter === after)) throw new Error('폴더 목록을 다시 불러와 주세요.');
    after = page.hasMore ? page.nextAfter : null;
  } while (after);
  return folders.filter(folder => !folder.deleted);
}

/**
 * One create or rename command. `operationId` identifies the user's intent: sending the same
 * id again after a lost reply applies the command exactly once and returns the first result.
 */
export function folderCommand(authority: FolderAuthority, operationId: string, commandType: 'createClassification'|'renameClassification', fields: Record<string, unknown>): Promise<CommandReply> {
  return api<CommandReply>('/v1/classifications/authority/commands', undefined,
    {libraryId: authority.libraryId, epoch: authority.epoch, contractVersion: authority.contractVersion, operationId, commandType, ...fields}, 'PUT');
}

/** Case-insensitive sibling-name check, a hint only: the server decides. */
export function siblingNameTaken(folders: readonly {id: string; name: string; parent_id: string|null}[], parentId: string|null, name: string, exceptId?: string): boolean {
  const wanted = name.trim().toLowerCase();
  return folders.some(folder => folder.id !== exceptId && (folder.parent_id ?? null) === parentId && folder.name.trim().toLowerCase() === wanted);
}

const CODE_TEXT: Record<string, string> = {
  duplicateClassificationName: '같은 위치에 같은 이름의 폴더가 있습니다.',
  emptyClassificationName: '폴더 이름을 입력해 주세요.',
  classificationNameTooLong: '폴더 이름이 너무 깁니다.',
  protectedClassification: '오리지널 기본 영역의 이름은 유지됩니다.',
  classificationNotFound: '폴더를 찾을 수 없습니다. 목록을 새로 고쳐 주세요.',
  revisionConflict: '다른 기기에서 이 폴더가 바뀌었습니다. 목록을 다시 불러온 뒤 시도해 주세요.',
  invalidClassificationParent: '이 위치에는 폴더를 만들 수 없습니다.',
};
/** The server's coded refusal in Korean, else the transport's own message. */
export function folderErrorText(reason: unknown): string {
  // An ApiError carries the server's structured detail; read it by shape so a caller that
  // mocks the transport (or a different error class) behaves the same.
  const details = (reason as {details?: {detail?: {code?: unknown}; code?: unknown} | null} | null)?.details;
  const code = details?.detail?.code ?? details?.code;
  if (typeof code === 'string' && CODE_TEXT[code]) return CODE_TEXT[code];
  return errorText(reason) || '폴더를 변경하지 못했습니다.';
}
