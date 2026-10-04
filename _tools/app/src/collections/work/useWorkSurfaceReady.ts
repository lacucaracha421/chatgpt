import { useRef } from "react";

type Part = "object" | "hero" | "backdrop" | "strip";
/** Report only the current presentation's painted parts to the shared entry gate. */
export function useWorkSurfaceReady(presentation: string, hero: boolean, backdrop: boolean, onReady: () => void, objectPresentation = presentation) {
  const readiness = useRef({ presentation, objectPresentation, object: false, hero, backdrop, strip: false });
  // A case reports each set of faces once; changing only its surroundings keeps that receipt.
  if (readiness.current.presentation !== presentation) readiness.current = { presentation, objectPresentation, object: readiness.current.objectPresentation === objectPresentation && readiness.current.object, hero, backdrop, strip: false };
  const current = readiness.current;
  return (part: Part) => {
    if (readiness.current !== current) return;
    current[part] = true;
    if (current.object && current.hero && current.backdrop && current.strip) onReady();
  };
}
