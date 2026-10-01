import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { ChevronDownIcon } from "@heroicons/react/24/outline";
import { SectionBar, type SectionBarProps } from "./SectionBar";

export type SectionDrop = {
  area?: string;
  barRef(element: HTMLElement | null): void;
  title(base: ReactNode, area?: string): ReactNode;
  overlay: ReactNode;
};

/** PC input and frame only; both copies render the shared SectionBar. */
export function useSectionDrop<T extends string>(bar: SectionBarProps<T>, enabled = true, area?: string) {
  const id = useId();
  const [away, setAway] = useState(false), [open, setOpen] = useState(false);
  const [topBar, setTopBar] = useState<HTMLElement | null>(null);
  const [inlineNode, setInlineNode] = useState<HTMLDivElement | null>(null);
  const [geometry, setGeometry] = useState({ left: 0, top: 0, width: 0 });
  const shade = useRef<HTMLDivElement>(null), titleButton = useRef<HTMLButtonElement>(null);
  const state = useRef({ away, open, enabled }); state.current = { away, open, enabled };
  const pinned = useRef(false), overTop = useRef(false), overShade = useRef(false);
  const enterTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const leaveTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const clearTimers = useCallback(() => { clearTimeout(enterTimer.current); clearTimeout(leaveTimer.current); }, []);
  // Radix triggers retain aria-expanded/aria-controls when their content portals to the document.
  const panels = useCallback(() => Array.from(shade.current?.querySelectorAll<HTMLElement>('[aria-expanded="true"][aria-controls]') ?? [])
    .map(trigger => document.getElementById(trigger.getAttribute("aria-controls")!)).filter((node): node is HTMLElement => !!node), []);
  const focused = useCallback(() => {
    const focus = document.activeElement;
    return !!focus && (shade.current?.contains(focus) || panels().some(panel => panel.contains(focus)));
  }, [panels]);
  const close = useCallback((restore = false) => {
    clearTimers(); pinned.current = false; overShade.current = false;
    if (restore || focused()) titleButton.current?.focus({ preventScroll: true });
    setOpen(false);
  }, [clearTimers, focused]);
  const leave = useCallback(() => {
    clearTimeout(enterTimer.current); clearTimeout(leaveTimer.current);
    if (pinned.current || overTop.current || overShade.current || focused() || panels().length) return;
    leaveTimer.current = setTimeout(() => {
      if (!pinned.current && !overTop.current && !overShade.current && !focused() && !panels().length) setOpen(false);
    }, 300);
  }, [focused, panels]);
  const enter = useCallback((immediate = false) => {
    clearTimeout(leaveTimer.current);
    if (!state.current.away || !state.current.enabled || state.current.open) return;
    clearTimeout(enterTimer.current);
    if (immediate) setOpen(true);
    else enterTimer.current = setTimeout(() => { if (state.current.away && state.current.enabled) setOpen(true); }, 150);
  }, []);
  useEffect(() => clearTimers, [clearTimers]);
  useLayoutEffect(() => {
    if (!enabled) { setAway(false); close(); }
  }, [enabled, close]);
  useLayoutEffect(() => {
    if (!inlineNode || !topBar || !enabled) return;
    const measure = (scroller?: HTMLElement) => {
      const rect = inlineNode.getBoundingClientRect(), header = topBar.getBoundingClientRect();
      setGeometry(current => current.left === rect.left && current.top === header.bottom && current.width === rect.width ? current : { left: rect.left, top: header.bottom, width: rect.width });
      let parent = scroller ?? inlineNode.parentElement;
      if (!scroller) {
        while (parent && parent !== document.body && !/(auto|scroll)/.test(getComputedStyle(parent).overflowY)) parent = parent.parentElement;
      }
      const nextAway = !!parent && parent.scrollTop > 0 && rect.bottom <= parent.getBoundingClientRect().top + parent.clientTop + 1;
      setAway(nextAway);
      if (!nextAway) close();
    };
    const scroll = (event: Event) => {
      const target = event.target;
      if (target instanceof HTMLElement && target.contains(inlineNode)) measure(target);
    };
    measure();
    const resize = () => measure();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(resize);
    observer?.observe(inlineNode); observer?.observe(topBar);
    document.addEventListener("scroll", scroll, true); window.addEventListener("resize", resize);
    return () => { observer?.disconnect(); document.removeEventListener("scroll", scroll, true); window.removeEventListener("resize", resize); };
  }, [inlineNode, topBar, enabled, close]);
  useEffect(() => {
    if (!topBar) return;
    const onEnter = () => { overTop.current = true; enter(); };
    const onLeave = () => { overTop.current = false; leave(); };
    topBar.addEventListener("pointerenter", onEnter); topBar.addEventListener("pointerleave", onLeave);
    return () => { overTop.current = false; clearTimers(); topBar.removeEventListener("pointerenter", onEnter); topBar.removeEventListener("pointerleave", onLeave); };
  }, [topBar, enter, leave, clearTimers]);
  useEffect(() => { if (away && overTop.current) enter(); }, [away, enter]);
  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (target && !topBar?.contains(target) && !shade.current?.contains(target) && !panels().some(panel => panel.contains(target))) close();
    };
    const key = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.isComposing) return;
      // Let the innermost menu handle Escape first, without closing its parent shade.
      if (panels().length) return;
      event.preventDefault(); event.stopPropagation(); close(true);
    };
    const focus = () => { if (focused()) clearTimeout(leaveTimer.current); else leave(); };
    const observer = new MutationObserver(leave);
    observer.observe(shade.current!, { subtree: true, attributes: true, attributeFilter: ["aria-expanded", "aria-controls"] });
    document.addEventListener("pointerdown", outside, true); document.addEventListener("keydown", key, true);
    document.addEventListener("focusin", focus); document.addEventListener("focusout", focus);
    return () => { observer.disconnect(); document.removeEventListener("pointerdown", outside, true); document.removeEventListener("keydown", key, true); document.removeEventListener("focusin", focus); document.removeEventListener("focusout", focus); };
  }, [open, topBar, panels, close, leave, focused]);
  const pick = (value: T) => { close(); bar.onChange(value); };
  const current = bar.options.find(option => option.value === bar.value)?.label;
  const drop: SectionDrop = {
    area,
    barRef: useCallback((element: HTMLElement | null) => setTopBar(element?.closest<HTMLElement>(".workspace-titlebar") ?? element), []),
    title: (base, area) => away && enabled ? <button ref={titleButton} className="ui-section-drop-title" type="button" aria-label={`${area ?? (typeof base === "string" ? base : "")} · ${current ?? ""}`} aria-expanded={open} aria-controls={id} onClick={event => {
      clearTimers();
      if (open) close();
      else {
        pinned.current = true; setOpen(true);
        if (event.detail === 0) requestAnimationFrame(() => shade.current?.querySelector<HTMLElement>('[role="radio"][tabindex="0"]')?.focus());
      }
    }}>{area ?? base}<span className="ui-section-drop-title__now">· {current}</span><ChevronDownIcon aria-hidden="true" /></button> : base,
    overlay: away && enabled ? createPortal(<div className="ui-section-drop-anchor" style={geometry}>
      <div className="ui-section-drop-hotstrip" aria-hidden="true" onPointerEnter={() => { overShade.current = true; enter(true); }} onPointerLeave={() => { overShade.current = false; leave(); }} />
      <div ref={shade} id={id} className={`ui-section-drop${open ? " is-open" : ""}`} aria-hidden={!open || undefined} inert={!open || undefined}
        onPointerEnter={() => { overShade.current = true; clearTimeout(leaveTimer.current); }} onPointerLeave={() => { overShade.current = false; leave(); }} onFocusCapture={() => clearTimeout(leaveTimer.current)}>
        <SectionBar {...bar} placement="shade" onChange={pick} onExtraClick={() => { close(); bar.onExtraClick?.(); }} />
      </div>
    </div>, document.body) : null,
  };
  return { ...drop, away, open, inline: enabled ? <SectionBar {...bar} placement="inline" ref={setInlineNode} onChange={pick} /> : null };
}

/** Toolbar-owned bars reach the list without moving or remounting its content. For virtual assets,
 * mount inside the existing measured intro so the virtualizer includes the bar's height. */
export function SectionDropMount({ children, host, target }: { children: ReactNode; host: string; target: string }) {
  const marker = useRef<HTMLSpanElement>(null);
  const [slot, setSlot] = useState<HTMLElement | null>(null);
  useLayoutEffect(() => {
    const root = marker.current?.closest(host);
    if (!root) return;
    let current: HTMLElement | null = null, destination: Element | null = null;
    const update = () => {
      const next = target.split(",").map(selector => root.querySelector(selector.trim())).find(Boolean) ?? null;
      if (next === destination) return;
      current?.remove(); destination = next;
      current = next ? document.createElement("div") : null;
      if (current) { current.className = "ui-section-drop-slot"; next!.prepend(current); }
      setSlot(current);
    };
    update();
    const observer = new MutationObserver(update); observer.observe(root, { childList: true, subtree: true });
    return () => { observer.disconnect(); current?.remove(); };
  }, [host, target]);
  return <><span ref={marker} hidden />{slot ? createPortal(children, slot) : children}</>;
}
