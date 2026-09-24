import { commandErrorMessage } from "../library/errorMessage";

/** Korean text for vault errors whose backend message depends on what the user typed. */
export function vaultErrorMessage(error: unknown, kind: "password" | "recoveryKey", fallback: string) {
  const code = typeof error === "object" && error !== null && "code" in error ? String(error.code) : "";
  if (code === "encrypted_vault_wrong_secret") return kind === "recoveryKey" ? "복구키가 맞지 않습니다." : "비밀번호가 맞지 않습니다.";
  if (code === "encrypted_vault_invalid_recovery_key") return "복구키는 64자리 영문·숫자입니다.";
  if (code === "encrypted_vault_not_found") return "비밀 보관함 USB를 찾을 수 없습니다.";
  return commandErrorMessage(error, fallback);
}
