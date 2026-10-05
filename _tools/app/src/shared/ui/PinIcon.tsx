import type { SVGProps } from "react";

// Heroicons has no pin; this pushpin follows its outline style (24 viewBox, stroke 1.5, round joins).
const PIN = "M8.4 3.6h7.2l-1.2 6 3.6 3.6H6l3.6-3.6-1.2-6zM12 13.2v7.2";

/** The one 고정 glyph for PC and tablet: outline at rest. */
export function PinIcon(props: SVGProps<SVGSVGElement>) {
  return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" {...props}><path d={PIN} /></svg>;
}

/** The solid pin, only for the on (고정됨) state. */
export function PinSolidIcon(props: SVGProps<SVGSVGElement>) {
  return <PinIcon fill="currentColor" {...props} />;
}
