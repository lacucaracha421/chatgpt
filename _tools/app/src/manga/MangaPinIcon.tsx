/** Pushpin, shared by the PC index and tablet filter chips. */
export function MangaPinIcon({solid=false}:{solid?:boolean}){
  return <svg viewBox="0 0 20 20" fill={solid?'currentColor':'none'} stroke="currentColor" strokeWidth={1.5} aria-hidden="true"><path d="M7 3h6l-1 5 3 3H5l3-3-1-5zM10 11v6" strokeLinejoin="round"/></svg>;
}
