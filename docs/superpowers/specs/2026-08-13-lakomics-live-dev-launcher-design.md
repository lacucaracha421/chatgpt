# Lakomics Live Dev Launcher Design

## Goal

Create a Windows shortcut that lets a non-developer start Lakomics in Tauri development mode and see code changes without manually entering terminal commands.

## Behavior

- The shortcut is named `Lakomics Live Dev.lnk`.
- One copy lives in the repository root and one copy lives on the user's desktop.
- It opens a visible command window in `C:\chatgpt\app`.
- The command window runs `npm.cmd run tauri dev` and remains open so build output and failures are visible.
- Frontend changes use Vite hot reload. Rust changes use Tauri's development rebuild and restart behavior.
- Closing the command window stops the development session.

## Safety and Scope

- Existing `Lakomics.lnk` and `Lakomics (Debug).lnk` shortcuts are not changed.
- No new launcher dependency or custom executable is introduced.
- The shortcut uses Windows' built-in `cmd.exe` and the project's existing npm/Tauri scripts.
- The launcher does not kill existing Lakomics processes or modify library data.

## Verification

- Inspect both shortcuts to confirm their target, arguments, working directory, and description.
- Launch the desktop shortcut and confirm the command window starts Tauri development mode.
- Confirm the Lakomics window opens and the terminal remains visible.
- Stop the verification session without changing user library data.
