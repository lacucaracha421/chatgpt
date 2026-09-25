/**
 * While a vault is being created or its one-time recovery key is on screen, leaving Settings
 * (or its 데이터 관리 section) would lose the key for good. `VaultSettings` marks that state
 * here; Esc then does nothing and other navigation out of Settings asks first.
 */
let pending = false;

const LEAVE_MESSAGE = "비밀 보관함 복구키를 아직 보관하지 않았습니다. 이 화면을 떠나면 복구키를 다시 볼 수 없습니다. 그래도 나갈까요?";

export function setVaultRecoveryPending(next: boolean) { pending = next; }

export function vaultRecoveryPending() { return pending; }

/** True when nothing is at stake or the user agreed to lose the recovery key. */
export function confirmLeaveVaultRecovery() {
  if (!pending) return true;
  if (!window.confirm(LEAVE_MESSAGE)) return false;
  pending = false;
  return true;
}
