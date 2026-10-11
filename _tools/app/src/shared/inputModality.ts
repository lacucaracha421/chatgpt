/**
 * Tracks whether the last input was a pointer or the keyboard on <html data-input>.
 * Panels move focus by script when they open; after a pointer open that must not paint a keyboard focus ring.
 */
export function initInputModality(root: HTMLElement = document.documentElement, target: Window = window): () => void {
  const set = (value: "pointer" | "keyboard") => { if (root.dataset.input !== value) root.dataset.input = value; };
  const onPointer = () => set("pointer");
  const onKey = (event: KeyboardEvent) => { if (!["Shift", "Control", "Alt", "Meta"].includes(event.key)) set("keyboard"); };
  target.addEventListener("pointerdown", onPointer, true);
  target.addEventListener("keydown", onKey, true);
  return () => { target.removeEventListener("pointerdown", onPointer, true); target.removeEventListener("keydown", onKey, true); };
}
