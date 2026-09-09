//! GTK URI drag-out; scheduled on the UI thread after background file preparation.
use super::CommandError;
use crate::library::PreparedAssetDrag;
use gtk::{gdk, glib, prelude::*};
use std::{cell::{Cell, RefCell}, rc::Rc};
use tauri::Emitter;

fn failure() -> CommandError {
    CommandError { code: "asset_drag_failed", message: "외부 드래그를 시작하지 못했습니다. 마우스 버튼을 누른 채 다시 끌어 주세요.".into() }
}

fn file_uris(paths: &[std::path::PathBuf]) -> Result<Vec<String>, CommandError> {
    paths.iter().map(|path| url::Url::from_file_path(path).map(String::from).map_err(|_| failure())).collect()
}

pub(super) fn start(window: &tauri::Window, prepared: PreparedAssetDrag, asset_ids: Vec<String>) -> Result<(), CommandError> {
    let widget = window.gtk_window().map_err(|_| failure())?;
    let pointer = widget.display().default_seat().and_then(|seat| seat.pointer()).ok_or_else(failure)?;
    let surface = widget.window().ok_or_else(failure)?;
    if !surface.device_position(&pointer).3.contains(gdk::ModifierType::BUTTON1_MASK) {
        #[cfg(debug_assertions)]
        eprintln!("asset drag: button released before native start");
        return Err(failure());
    }
    let uris = file_uris(&prepared.files)?;
    let icon = gtk::gdk_pixbuf::Pixbuf::from_file_at_scale(&prepared.preview, 96, 96, true).ok();
    let pending = Rc::new(RefCell::new(Some(prepared)));
    let failed = Rc::new(Cell::new(false));
    let handlers = Rc::new(RefCell::new(Vec::<glib::SignalHandlerId>::new()));
    handlers.borrow_mut().push(widget.connect_drag_data_get(move |_, _, selection, _, _| {
        selection.set_uris(&uris.iter().map(String::as_str).collect::<Vec<_>>());
    }));
    let cancelled = failed.clone();
    handlers.borrow_mut().push(widget.connect_drag_failed(move |_, _, reason| {
        #[cfg(debug_assertions)]
        eprintln!("asset drag: GTK failed: {reason:?}");
        cancelled.set(true);
        glib::Propagation::Proceed
    }));
    let completion = pending.clone();
    let end_handlers = handlers.clone();
    let callback_window = window.clone();
    handlers.borrow_mut().push(widget.connect_drag_end(move |widget, _| {
        if let Some(prepared) = completion.borrow_mut().take() {
            if !failed.get() { prepared.retain_for_external_copy(); }
        }
        let _ = callback_window.emit("asset-drag://ended", &asset_ids);
        for handler in end_handlers.take() { widget.disconnect(handler); }
    }));
    let targets = gtk::TargetList::new(&[gtk::TargetEntry::new("text/uri-list", gtk::TargetFlags::empty(), 0)]);
    // GTK expects the button number (1), not the BUTTON1_MASK bit flag.
    // COPY deliberately prevents recipients from requesting a source deletion.
    let context = widget.drag_begin_with_coordinates(&targets, gdk::DragAction::COPY, 1, None, -1, -1);
    match context {
        Some(context) => {
            #[cfg(debug_assertions)]
            eprintln!("asset drag: native drag started");
            if let Some(icon) = icon { context.drag_set_icon_pixbuf(&icon, 0, 0); }
            else { context.drag_set_icon_default(); }
            Ok(())
        }
        None => {
            for handler in handlers.take() { widget.disconnect(handler); }
            pending.borrow_mut().take();
            Err(failure())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn linux_drag_uris_escape_names_and_reject_relative_paths() {
        let paths = [std::path::PathBuf::from("/tmp/토와 #1%?.png"), std::path::PathBuf::from("/tmp/second image.png")];
        let uris = file_uris(&paths).unwrap();
        for (uri, path) in uris.iter().zip(paths) {
            assert_eq!(url::Url::parse(uri).unwrap().to_file_path().unwrap(), path);
            assert!(!uri.contains(' '));
            assert!(!uri.contains('#'));
        }
        assert!(file_uris(&["relative.png".into()]).is_err());
    }
}
