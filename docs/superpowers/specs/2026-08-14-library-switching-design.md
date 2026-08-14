# Library Switching Design

## Goal

Allow a user with an open Lakomics library to select and open a different library without restarting the application or losing the current library when selection fails.

## Entry point

Add a `다른 저장소 열기` button to the library folder property in Settings → General. Library switching is an occasional management action, so it belongs with the displayed library path rather than in the persistent navigation sidebar.

## Behavior

1. The user selects `다른 저장소 열기`.
2. Lakomics opens the existing native directory picker.
3. Canceling the picker leaves the current library and settings screen unchanged.
4. Selecting the currently open library is allowed and reuses the existing backend library instance.
5. Selecting a valid different library opens it before changing frontend state.
6. After a successful switch, Lakomics stores the selected path and remounts the library workspace using the new library root. This clears the previous library's navigation, selection, paging, and transient work state before loading the new library.
7. If opening fails, Lakomics displays the established public library error in Settings and continues using the current library.

The switch button is disabled while the picker or open operation is pending and while Settings already considers library maintenance pending.

## State boundaries

`LibraryProvider.openLibrary(path)` must preserve the currently open `LibrarySummary` when `gateway.openLibrary(path)` fails. It should continue to set `library` to `null` only when an initial automatic or setup-screen open fails and no current library exists.

`LibraryScreen` keys `LibraryWorkspace` by `library.root`. A successful change to a different root therefore creates a fresh workspace instance without adding manual reset logic for every child state variable.

`SettingsView` owns the picker interaction because it already owns the General settings UI and imports the native directory dialog. It calls the shared `openLibrary` context operation instead of invoking the gateway directly.

## Error handling

- Picker cancellation is not an error.
- Failed opens use `commandErrorMessage` through `LibraryContext` and remain visible in the General settings section.
- The previous library stays mounted and usable after a failed switch.
- No database files or assets are moved, copied, or deleted during switching.

## Testing

- Context test: a failed switch preserves an already open library and exposes the public error.
- Settings test: canceling the picker does not call `openLibrary`.
- Settings test: selecting a folder calls `openLibrary`, disables duplicate submission while pending, and shows a switch error without replacing the current path.
- App test: changing `library.root` remounts the workspace and reloads classifications and assets for the new library.
- Run the full frontend and Rust test suites plus the production frontend build.
- Rebuild and launch the Tauri application to verify the Settings interaction manually.

## Out of scope

- Migrating the remembered path from origin-scoped WebView `localStorage` to a Tauri-owned shared preference file.
- Recent-library history, pinned libraries, or a multi-library sidebar.
- Switching libraries while retaining the previous library's navigation or asset selection state.

