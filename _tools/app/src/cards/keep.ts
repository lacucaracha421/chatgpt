// Types only: the tablet shares this module and must never load the PC's Tauri calls.
import type { OpenResult } from "./api";

/** Why a keep shows the pack as the server holds it instead of its own answer. */
export type KeepRefusal = "decided" | "expired";

/**
 * Sends a keep. When it fails, the pack is read back: the reply may have been lost after the album
 * took the cards, another device may have decided the pack, or its keep window closed. A decided or
 * expired pack is then shown as the server holds it, instead of offering a retry that cannot succeed.
 * A pack still waiting, or a failed read, rethrows the keep's own error.
 */
export async function keepOrRead(keep: () => Promise<OpenResult>, read: () => Promise<OpenResult>, slots: readonly number[]): Promise<{ result: OpenResult; refused?: KeepRefusal }> {
  try { return { result: await keep() }; }
  catch (failure) {
    const current = await read().catch(() => null);
    if (!current || (!current.keptAt && !current.expired)) throw failure;
    if (!current.keptAt) return { result: current, refused: "expired" };
    const kept = current.cards.flatMap((card, index) => card.kept ? [card.slot ?? index] : []);
    // Exactly the slots this keep sent: its own decision whose reply was lost.
    const own = kept.length === slots.length && kept.every(slot => slots.includes(slot));
    return own ? { result: current } : { result: current, refused: "decided" };
  }
}
