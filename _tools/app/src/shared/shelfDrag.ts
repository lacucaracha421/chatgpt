import { flushSync } from "react-dom";
import type { ShelfBridge } from "./ui/ShelfScroller";
import { HOLD_MS, PRESS_SLOP_PX, edgeScrollSpeed, inCentralZone, insertionIndex, movedToIndex, slideOffsets, type OrderKind, type SlotBox } from "./shelfOrder";

/** What a finished carry asks the owner to do. `null` (to `onEnd`) means nothing changed or it was cancelled. */
export type DropIntent =
  | { type: "reorder"; kind: OrderKind; ids: string[] }
  | { type: "into"; targetId: string; groupId: string }
  | { type: "out"; targetId: string };

/** The drop place under the carried card, for the faces the owner draws (그룹에 넣기, 그룹에서 빼기). */
export type DragOver = { groupId: string | null; takeOut: boolean };
export const NO_OVER: DragOver = { groupId: null, takeOut: false };

export type ShelfDragHost = {
  /** The ids of the band the card belongs to, in shelf order; `null` when it cannot be carried now. */
  band(kind: OrderKind, id: string): readonly string[] | null;
  /** A character may be dropped on the middle of a group card (the series shelf). */
  canPutIn: boolean;
  /** A character may be dropped on the 그룹에서 빼기 slot (a group view). */
  canTakeOut: boolean;
  /** Runs synchronously (inside flushSync) when a card lifts, so the owner can add the take-out slot before the shelf is measured. */
  onLift(kind: OrderKind, id: string): void;
  onOver(over: DragOver): void;
  /**
   * Runs synchronously (inside flushSync) when the carry ends; the intent is applied in the same frame
   * the cards are released. For a put-in / take-out it returns a promise of whether the change was stored: the
   * carried card's place then stays hidden until the card leaves the shelf (or at once when it was not stored).
   */
  onEnd(intent: DropIntent | null): void | Promise<boolean | void>;
};

const GLIDE_MS = 140;
const reducedMotion = () => Boolean(window.matchMedia?.("(prefers-reduced-motion: reduce)").matches);
const cardsOf = (track: HTMLElement) => [...track.children].filter((child): child is HTMLElement => child instanceof HTMLElement);

/**
 * Carrying a card of a folder or character shelf. A mouse press on a `[data-order-id]` card that stays put
 * for HOLD_MS lifts it; moving PRESS_SLOP_PX or more first leaves the press to the shelf's own
 * panning. While carried the card is a floating clone, its own place stays as a placeholder, and the
 * cards of its band slide (transforms only: the layout never changes, so hit tests stay stable).
 */
export class ShelfDrag {
  private phase: "idle" | "pressed" | "lifted" | "settling" = "idle";
  private press: { x: number; y: number; kind: OrderKind; id: string; card: HTMLElement } | null = null;
  private timer: number | null = null;
  private last = { x: 0, y: 0 };
  private kind: OrderKind = "character";
  private id = "";
  private track: HTMLElement | null = null;
  private source: HTMLElement | null = null;
  private ghost: HTMLElement | null = null;
  private grab = { x: 0, y: 0 };
  private slots: SlotBox[] = [];
  private origin = 0;
  private home = { left: 0, top: 0 };
  private scroll0 = 0;
  private index = 0;
  private onShelf = true;
  private over: DragOver = NO_OVER;
  private frame: number | null = null;

  constructor(private readonly root: HTMLElement, private readonly bridge: ShelfBridge, private readonly host: () => ShelfDragHost) {}

  attach() {
    this.root.addEventListener("pointerdown", this.down);
    return () => this.dispose();
  }

  dispose() {
    this.root.removeEventListener("pointerdown", this.down);
    this.releasePress();
    if (this.phase === "lifted") this.stopCarrying(true);
  }

  private readonly down = (event: PointerEvent) => {
    if (this.phase !== "idle" || event.pointerType !== "mouse" || event.button !== 0) return;
    const target = event.target instanceof Element ? event.target : null;
    const card = target?.closest<HTMLElement>("[data-order-id]");
    if (!card || !this.root.contains(card) || target?.closest(".series-character__info")) return;
    const kind = card.dataset.orderKind as OrderKind, id = card.dataset.orderId!;
    if (!this.host().band(kind, id)) return;
    this.press = { x: event.clientX, y: event.clientY, kind, id, card };
    this.last = { x: event.clientX, y: event.clientY };
    this.phase = "pressed";
    this.timer = window.setTimeout(this.lift, HOLD_MS);
    document.addEventListener("pointermove", this.pressMove, true);
    document.addEventListener("pointerup", this.pressEnd, true);
    document.addEventListener("pointercancel", this.pressEnd, true);
  };

  private readonly pressMove = (event: PointerEvent) => {
    if (!this.press) return;
    this.last = { x: event.clientX, y: event.clientY };
    // Moving first is today's pan with inertia: the shelf already handles it.
    if (Math.hypot(event.clientX - this.press.x, event.clientY - this.press.y) >= PRESS_SLOP_PX) this.releasePress();
  };

  private readonly pressEnd = () => this.releasePress();

  private releasePress() {
    if (this.timer !== null) window.clearTimeout(this.timer);
    this.timer = null;
    document.removeEventListener("pointermove", this.pressMove, true);
    document.removeEventListener("pointerup", this.pressEnd, true);
    document.removeEventListener("pointercancel", this.pressEnd, true);
    if (this.phase === "pressed") { this.phase = "idle"; this.press = null; }
  }

  private readonly lift = () => {
    const press = this.press;
    this.timer = null;
    if (!press || this.phase !== "pressed") return;
    document.removeEventListener("pointermove", this.pressMove, true);
    document.removeEventListener("pointerup", this.pressEnd, true);
    document.removeEventListener("pointercancel", this.pressEnd, true);
    this.kind = press.kind; this.id = press.id;
    this.phase = "lifted";
    this.bridge.locked = true;
    const host = this.host();
    // The owner may add the 그룹에서 빼기 slot first; measure afterwards.
    flushSync(() => host.onLift(this.kind, this.id));
    const track = this.bridge.track;
    const source = track && cardsOf(track).find(card => card.dataset.orderId === this.id && card.dataset.orderKind === this.kind);
    if (!track || !source) { this.stopCarrying(false); return; }
    this.track = track; this.source = source;
    this.measure();
    const rect = source.getBoundingClientRect();
    this.grab = { x: this.last.x - rect.left, y: this.last.y - rect.top };
    this.home = { left: rect.left, top: rect.top };
    this.scroll0 = track.scrollLeft;
    this.index = this.origin = Math.max(0, this.slots.findIndex(slot => slot.id === this.id));
    this.ghost = this.makeGhost(source, rect);
    source.dataset.reorderState = "source";
    track.dataset.reordering = "true";
    document.documentElement.classList.add("is-shelf-reordering");
    document.addEventListener("pointermove", this.move, true);
    document.addEventListener("pointerup", this.up, true);
    document.addEventListener("pointercancel", this.released, true);
    document.addEventListener("keydown", this.key, true);
    window.addEventListener("blur", this.cancel);
    track.addEventListener("scroll", this.rescroll);
    this.frame = requestAnimationFrame(this.tick);
    this.update();
  };

  private measure() {
    const track = this.track!;
    const trackRect = track.getBoundingClientRect();
    this.slots = cardsOf(track).filter(card => card.dataset.orderKind === this.kind && card.dataset.orderId).map(card => {
      const rect = card.getBoundingClientRect();
      return { id: card.dataset.orderId!, left: rect.left - trackRect.left + track.scrollLeft, width: rect.width };
    });
  }

  private makeGhost(source: HTMLElement, rect: DOMRect) {
    const clone = source.cloneNode(true) as HTMLElement;
    clone.querySelectorAll("[data-order-id], [id]").forEach(node => { node.removeAttribute("data-order-id"); node.removeAttribute("id"); });
    clone.removeAttribute("data-order-id");
    clone.querySelectorAll(".series-character__info, [data-into-face]").forEach(node => node.remove());
    clone.querySelectorAll("button").forEach(button => button.setAttribute("tabindex", "-1"));
    const ghost = document.createElement("div");
    ghost.className = "folder-shelf shelf-drag-ghost";
    ghost.setAttribute("aria-hidden", "true");
    ghost.style.cssText = `position:fixed;left:0;top:0;width:${rect.width}px;pointer-events:none;z-index:1000;`;
    ghost.append(clone);
    document.body.append(ghost);
    this.place(ghost);
    return ghost;
  }

  private place(ghost: HTMLElement) {
    ghost.style.transform = `translate(${this.last.x - this.grab.x}px, ${this.last.y - this.grab.y}px)`;
  }

  private readonly move = (event: PointerEvent) => {
    this.last = { x: event.clientX, y: event.clientY };
    this.update();
  };

  private readonly rescroll = () => this.update();

  private update() {
    const track = this.track, ghost = this.ghost;
    if (!track || !ghost || this.phase !== "lifted") return;
    this.place(ghost);
    const { x, y } = this.last;
    const rect = track.getBoundingClientRect();
    this.onShelf = x >= rect.left && x <= rect.right && y >= rect.top - 16 && y <= rect.bottom + 16;
    const host = this.host();
    let over = NO_OVER;
    if (this.onShelf && this.kind === "character") {
      const inside = (card: HTMLElement, central: boolean) => {
        const box = card.getBoundingClientRect();
        return y >= box.top && y <= box.bottom && (central ? inCentralZone(box.left, box.width, x) : x >= box.left && x <= box.right);
      };
      const cards = cardsOf(track);
      if (host.canPutIn) {
        const group = cards.find(card => card.dataset.orderKind === "group" && inside(card, true));
        if (group) over = { groupId: group.dataset.orderId!, takeOut: false };
      }
      if (host.canTakeOut && !over.groupId) {
        const slot = cards.find(card => card.hasAttribute("data-take-out") && inside(card, false));
        if (slot) over = { groupId: null, takeOut: true };
      }
    }
    if (over.groupId !== this.over.groupId || over.takeOut !== this.over.takeOut) { this.over = over; host.onOver(over); }
    ghost.classList.toggle("is-over", over.groupId !== null || over.takeOut);
    // Over a drop place, or off the shelf, no gap is open: the carried card's own place stays.
    this.index = !this.onShelf || over.groupId || over.takeOut ? this.origin : insertionIndex(this.slots, this.id, x - rect.left + track.scrollLeft);
    const offsets = slideOffsets(this.slots, this.id, this.index);
    for (const card of cardsOf(track)) {
      if (card.dataset.orderKind !== this.kind || !card.dataset.orderId) continue;
      const shift = offsets.get(card.dataset.orderId);
      card.style.transform = shift === undefined ? "" : `translateX(${shift}px)`;
    }
  }

  /** The shelf scrolls by itself while the pointer rests in a 48px zone at either end. */
  private readonly tick = () => {
    this.frame = null;
    const track = this.track;
    if (!track || this.phase !== "lifted") return;
    const rect = track.getBoundingClientRect();
    const speed = this.last.y >= rect.top - 16 && this.last.y <= rect.bottom + 16 ? edgeScrollSpeed(this.last.x, rect.left, rect.right) : 0;
    if (speed !== 0) {
      const before = track.scrollLeft;
      track.scrollLeft = Math.max(0, Math.min(track.scrollWidth - track.clientWidth, before + speed));
      if (track.scrollLeft !== before) this.update();
    }
    this.frame = requestAnimationFrame(this.tick);
  };

  private readonly key = (event: KeyboardEvent) => {
    if (event.key !== "Escape") return;
    event.preventDefault(); event.stopPropagation();
    this.cancel();
  };

  private intent(): DropIntent | null {
    if (!this.onShelf) return null;
    if (this.over.groupId) return { type: "into", targetId: this.id, groupId: this.over.groupId };
    if (this.over.takeOut) return { type: "out", targetId: this.id };
    const ids = movedToIndex(this.slots.map(slot => slot.id), this.id, this.index);
    return ids ? { type: "reorder", kind: this.kind, ids } : null;
  }

  private readonly up = (event: PointerEvent) => {
    if (this.phase !== "lifted") return;
    this.last = { x: event.clientX, y: event.clientY };
    this.update();
    const intent = this.intent();
    // Dropping off the shelf cancels; a drop on the card's own place just puts it back.
    if (!this.onShelf) { this.finish(null, true, true); return; }
    this.finish(intent, false, true);
  };

  /** Esc or losing the window: the pointer may still be down, so the click after its release is still swallowed. */
  readonly cancel = () => { if (this.phase === "lifted") this.finish(null, true, false); };
  /** The system cancelled the pointer: it is up already. */
  private readonly released = () => { if (this.phase === "lifted") this.finish(null, true, true); };

  private finish(intent: DropIntent | null, cancelled: boolean, released: boolean) {
    const track = this.track, ghost = this.ghost;
    const host = this.host();
    this.stopListening();
    this.phase = "settling";
    // The click that follows the release lands on the carried card; it must not open it.
    const swallow = (event: Event) => { event.stopPropagation(); event.preventDefault(); };
    window.addEventListener("click", swallow, { capture: true, once: true });
    const unswallow = () => window.setTimeout(() => window.removeEventListener("click", swallow, { capture: true }), 100);
    if (released) unswallow(); else document.addEventListener("pointerup", unswallow, { once: true, capture: true });
    const animate = !reducedMotion() && typeof ghost?.animate === "function";
    const cards = track ? cardsOf(track).filter(card => card.dataset.orderKind === this.kind) : [];
    if (cancelled || !intent) {
      // Neighbours and placeholder slide back; the clone glides to the place it came from.
      for (const card of cards) card.style.transform = "";
      flushSync(() => { host.onEnd(null); });
      const finish = () => this.release(cards);
      if (!animate || !ghost) { finish(); return; }
      // The placeholder is still sliding back, so the place it came from is computed, not measured.
      this.glide(ghost, this.home.left + this.scroll0 - (track?.scrollLeft ?? this.scroll0), this.home.top, finish);
      return;
    }
    if (intent.type !== "reorder") {
      // Put in / take out: the card leaves this shelf once the change is stored; its place stays until then.
      if (track) delete track.dataset.reordering;
      for (const card of cards) card.style.transform = "";
      let pending: void | Promise<boolean | void> = undefined;
      flushSync(() => { pending = host.onEnd(intent); });
      if (animate && ghost) {
        const fade = ghost.animate([{ opacity: 0.94 }, { opacity: 0 }], { duration: GLIDE_MS, fill: "forwards" });
        fade.addEventListener("finish", () => ghost.remove(), { once: true });
      } else ghost?.remove();
      const source = this.source;
      void Promise.resolve(pending).then(stored => (stored as boolean | undefined) !== false, () => false).then(stored => {
        // Stored: the card leaves the shelf when the owner's lists refresh; its place stays hidden until then (at most 2 s).
        if (!stored || !source || !track) { this.release(cards); return; }
        let done = false;
        const finishNow = () => { if (done) return; done = true; observer.disconnect(); window.clearTimeout(timer); this.release(cards); };
        const observer = new MutationObserver(() => { if (!source.isConnected) finishNow(); });
        observer.observe(track, { childList: true });
        const timer = window.setTimeout(finishNow, 2000);
        if (!source.isConnected) finishNow();
      });
      return;
    }
    // Apply at once: release every transform without a transition, commit, then glide the clone into the real card.
    if (track) delete track.dataset.reordering;
    for (const card of cards) card.style.transform = "";
    flushSync(() => { host.onEnd(intent); });
    const landed = track ? cardsOf(track).find(card => card.dataset.orderId === this.id && card.dataset.orderKind === this.kind) : null;
    if (animate && ghost && landed) {
      landed.dataset.reorderState = "landing";
      const rect = landed.getBoundingClientRect();
      this.glide(ghost, rect.left, rect.top, () => this.release(cardsOf(track!)));
    } else this.release(track ? cardsOf(track) : []);
  }

  private glide(ghost: HTMLElement, left: number, top: number, done: () => void) {
    const from = ghost.style.transform;
    const animation = ghost.animate([{ transform: from }, { transform: `translate(${left}px, ${top}px)` }], { duration: GLIDE_MS, easing: "cubic-bezier(.2,0,0,1)", fill: "forwards" });
    const end = () => done();
    animation.addEventListener("finish", end, { once: true });
    animation.addEventListener("cancel", end, { once: true });
  }

  private stopListening() {
    if (this.frame !== null) cancelAnimationFrame(this.frame);
    this.frame = null;
    document.removeEventListener("pointermove", this.move, true);
    document.removeEventListener("pointerup", this.up, true);
    document.removeEventListener("pointercancel", this.released, true);
    document.removeEventListener("keydown", this.key, true);
    window.removeEventListener("blur", this.cancel);
    this.track?.removeEventListener("scroll", this.rescroll);
  }

  /** Removes everything the carry added to the page. */
  private release(cards: HTMLElement[]) {
    this.ghost?.remove();
    for (const card of cards) { card.style.transform = ""; card.style.transition = ""; delete card.dataset.reorderState; }
    if (this.track) { delete this.track.dataset.reordering; }
    this.source?.removeAttribute("data-reorder-state");
    document.documentElement.classList.remove("is-shelf-reordering");
    this.bridge.locked = false;
    this.ghost = null; this.source = null; this.track = null; this.press = null;
    this.over = NO_OVER;
    this.phase = "idle";
  }

  private stopCarrying(ignoreHost: boolean) {
    this.stopListening();
    const cards = this.track ? cardsOf(this.track) : [];
    if (!ignoreHost) this.host().onEnd(null);
    this.release(cards);
  }
}
