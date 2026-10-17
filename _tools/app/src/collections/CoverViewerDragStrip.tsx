/** Invisible strip along the top of the full-window cover viewers; dragging it moves the window. */
export function CoverViewerDragStrip() {
  return <div className="manga-cover-viewer__drag-strip" data-tauri-drag-region="deep" aria-hidden="true"
    onPointerDown={event => event.stopPropagation()}
    onPointerMove={event => event.stopPropagation()}
    onPointerUp={event => event.stopPropagation()}
    onPointerCancel={event => event.stopPropagation()} />;
}
