import { useCallback, useRef } from "react";
import { motionDefaults, motionSpring, motionTime, prefersReducedMotion } from "./motionCurves";

export type MotionSurface = "menu" | "dialog" | "scrim" | "toast" | "selection";
const properties = ["opacity", "translate", "scale"] as const;
type LeavingSurface = { node: HTMLElement; remove(): void };
// Conditional sheet owners remount on reopen; their title still identifies the same surface.
const snapshots = new Map<string, LeavingSurface>();
const snapshotsByNode = new WeakMap<HTMLElement, LeavingSurface>();

export function surfaceExitTime(kind: MotionSurface, node: Element) {
  if (prefersReducedMotion()) return motionTime("--motion-micro", motionDefaults.micro, node);
  if (kind === "toast") return motionTime("--motion-toast-exit", motionDefaults.toastExit, node);
  if (kind === "scrim") return motionTime("--motion-medium", motionDefaults.medium, node);
  if (kind === "selection") return motionTime("--motion-small", motionDefaults.small, node);
  return motionSpring(kind === "menu" ? "snappy" : "gentle", node).duration * .7;
}

/** Transitions reverse from the painted value; Radix's closed animation only owns presence. */
export function useMotionSurface(kind: MotionSurface, enabled = true, identity?: string) {
  const detach = useRef<(() => void) | null>(null);
  const leaving = useRef<LeavingSurface | null>(null);
  const snapshotKey = identity ? `${kind}:${identity}` : undefined;
  return useCallback((node: HTMLElement | null) => {
    detach.current?.(); detach.current = null;
    if (!node || !enabled) return;
    node.dataset.motion = kind;
    const selectionGhost = kind === "selection" ? node.parentElement?.parentElement?.querySelector<HTMLElement>(':scope > [data-motion="selection"][data-motion-ghost]') : null;
    const previous = leaving.current ?? (snapshotKey ? snapshots.get(snapshotKey) : undefined) ?? (selectionGhost ? snapshotsByNode.get(selectionGhost) : undefined);
    if (previous) {
      const style = getComputedStyle(previous.node);
      for (const property of properties) node.style.setProperty(property, style.getPropertyValue(property));
      previous.remove();
    } else node.dataset.motionEntering = "";
    // Establish the starting style before the first paint, including portals mounted already open.
    void getComputedStyle(node).opacity;
    const frame = requestAnimationFrame(() => {
      delete node.dataset.motionEntering;
      for (const property of properties) node.style.removeProperty(property);
    });
    const update = () => {
      const closed = node.dataset.state === "closed";
      node.inert = closed;
      if (closed) node.setAttribute("aria-hidden", "true");
      else node.removeAttribute("aria-hidden");
    };
    update();
    const observer = new MutationObserver(update);
    observer.observe(node, { attributes: true, attributeFilter: ["data-state"] });
    detach.current = () => {
      observer.disconnect(); cancelAnimationFrame(frame);
      // Conditional callers (toasts and tablet sheets) can remove the whole owner. Keep only
      // an inert paint snapshot; focus, scroll locks and React handlers leave immediately.
      if (!node.isConnected || !node.getBoundingClientRect().width
        || kind === "menu") return;
      const style = getComputedStyle(node);
      if (node.dataset.state === "closed" && Number(style.opacity) === 0) return;
      const snapshot = node.cloneNode(true) as HTMLElement;
      snapshot.dataset.motionGhost = "";
      delete snapshot.dataset.motionEntering;
      snapshot.inert = true;
      snapshot.setAttribute("aria-hidden", "true");
      for (const element of [snapshot, ...snapshot.querySelectorAll("[id], [role], [aria-live]")]) {
        element.removeAttribute("id"); element.removeAttribute("role"); element.removeAttribute("aria-live");
      }
      for (const property of properties) snapshot.style.setProperty(property, style.getPropertyValue(property));
      if (kind === "toast") snapshot.style.transform = style.transform;
      snapshot.style.transition = "none";
      if (kind === "selection") node.parentElement?.after(snapshot);
      else node.after(snapshot);
      const originals = [node, ...node.querySelectorAll<HTMLElement>("*")];
      const copies = [snapshot, ...snapshot.querySelectorAll<HTMLElement>("*")];
      originals.forEach((original, index) => {
        if (original.scrollTop) copies[index]!.scrollTop = original.scrollTop;
        if (original.scrollLeft) copies[index]!.scrollLeft = original.scrollLeft;
      });
      void getComputedStyle(snapshot).opacity;
      let timer: number | undefined;
      const remove = () => {
        clearTimeout(timer); cancelAnimationFrame(exitFrame); snapshot.remove();
        if (leaving.current?.node === snapshot) leaving.current = null;
        if (snapshotKey && snapshots.get(snapshotKey)?.node === snapshot) snapshots.delete(snapshotKey);
      };
      const exitFrame = requestAnimationFrame(() => {
        snapshot.style.removeProperty("transition");
        snapshot.dataset.state = "closed";
        for (const property of properties) snapshot.style.removeProperty(property);
        timer = window.setTimeout(remove, surfaceExitTime(kind, snapshot));
      });
      leaving.current = { node: snapshot, remove };
      snapshotsByNode.set(snapshot, leaving.current);
      if (snapshotKey) { snapshots.get(snapshotKey)?.remove(); snapshots.set(snapshotKey, leaving.current); }
    };
  }, [kind, enabled, snapshotKey]);
}
