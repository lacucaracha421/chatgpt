import {native,errorText} from './transport';

/**
 * The PC notes store drives the tablet too (same queue, rebase, keep-both and secret-lock
 * semantics); only its transport differs. Native errors reach it as their Korean text, which
 * is what the store shows and matches (the PIN prompt texts).
 */
const OPERATIONS:Record<string,string>={state:'notesState',unlock:'notesUnlock',save:'notesSave',sync:'notesSync',secretStatus:'notesSecretStatus',secretSetPin:'notesSecretSetPin',secretUnlock:'notesSecretUnlock',secretResetPin:'notesSecretResetPin',secretLock:'notesSecretLock',secretTouch:'notesSecretTouch',dismissConflictCopy:'notesDismissConflictCopy',recoveryKey:'notesRecoveryKey',ledgerMonthId:'notesLedgerMonthId'};
export function mobileNotesRequest<T>(operation:string,input:unknown={}):Promise<T> {
  const op=OPERATIONS[operation];
  if(!op)return Promise.reject('이 기기에서는 지원하지 않는 메모 작업입니다.');
  return native<T>(op,input as Record<string,unknown>).catch((reason:unknown)=>{throw errorText(reason)||'메모 작업을 완료하지 못했습니다. 작성 내용은 유지됩니다.';});
}

