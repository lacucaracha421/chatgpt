import type { SVGProps } from "react";

// Heroicons has no sidebar toggle. Drawn in its outline style: a window with its left panel,
// and a chevron in the content area saying which way the panel goes.
function SidebarGlyph({ chevron, ...props }: SVGProps<SVGSVGElement> & { chevron: string }) {
  return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" {...props}>
    <rect x="3" y="4.5" width="18" height="15" rx="2" />
    <path d={`M9 4.5v15${chevron}`} />
  </svg>;
}

export const SidebarCloseIcon = (props: SVGProps<SVGSVGElement>) => <SidebarGlyph chevron="M16.5 9 13.5 12l3 3" {...props} />;
export const SidebarOpenIcon = (props: SVGProps<SVGSVGElement>) => <SidebarGlyph chevron="M13.5 9l3 3-3 3" {...props} />;
