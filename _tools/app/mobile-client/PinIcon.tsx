import type {SVGProps} from 'react';
/** Outline push-pin in the Heroicons style (Heroicons has no pin glyph). */
export function PinIcon(props:SVGProps<SVGSVGElement>) {
  return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" {...props}><path d="M15.75 3.75 20.25 8.25M18 6l-4.5 4.5 1.5 5.25-2.25 2.25-3.375-3.375L4.5 19.5M9.375 14.625 6 11.25 8.25 9l5.25 1.5"/></svg>;
}
