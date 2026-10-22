// Shared by the PC and the tablet: no Tauri or native bridge here, only this device's storage.
import type { OpenResult } from "./api";

/** Opened, not yet decided and still inside the keep window: the results view may offer the keep step. */
export const isUndecided = (result: Pick<OpenResult, "keptAt" | "expired">) => !result.keptAt && !result.expired;

// The last opened pack and the retry keys live on this device only; the server still owns the result.
const key = (root: string, name: string) => `lakomics.cards.${name}:${root}`;
export function readResult(root: string): OpenResult | null {
  try { const value = JSON.parse(localStorage.getItem(key(root, "last")) ?? "null") as OpenResult | null; return value?.cards?.length === 5 ? value : null; } catch { return null; }
}
export function saveResult(root: string, result: OpenResult) {
  try { localStorage.setItem(key(root, "last"), JSON.stringify(result)); } catch { /* The server still owns the result. */ }
}
/** `kind` separates the open and keep retries of one pack; "operation" is the open key stored by earlier versions. */
export type OperationKind = "operation" | "keep";
const UUID = /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
/**
 * The retry key of one pack command. It is stored BEFORE the request, so a request that timed out
 * (or an app that was closed mid-request) is repeated with the same key and the server answers
 * with the first outcome instead of drawing or keeping twice. Without storage the call throws and
 * the pack is not consumed.
 */
export function operationId(root: string, packId: string, kind: OperationKind = "operation"): string {
  const name = key(root, `${kind}:${packId}`), old = localStorage.getItem(name);
  if (old && UUID.test(old)) return old;
  const id = crypto.randomUUID(); localStorage.setItem(name, id); return id;
}
export function finishOperation(root: string, packId: string, kind: OperationKind = "operation") {
  try { localStorage.removeItem(key(root, `${kind}:${packId}`)); } catch { /* Safe to reuse after success. */ }
}
