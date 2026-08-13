# Lakomics Live Dev Launcher Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Create repository-root and desktop shortcuts that start Lakomics in visible Tauri development mode with live frontend reload and Rust rebuilds.

**Architecture:** Use Windows' built-in `WScript.Shell` shortcut API. Each shortcut launches `cmd.exe` in `C:\chatgpt\app` with `/k npm.cmd run tauri dev`, keeping logs visible without adding a launcher dependency.

**Tech Stack:** Windows shortcut (`.lnk`), `cmd.exe`, npm, Tauri CLI, Vite

## Global Constraints

- Preserve `Lakomics.lnk` and `Lakomics (Debug).lnk` unchanged.
- Create `Lakomics Live Dev.lnk` in `C:\chatgpt` and on the user's desktop.
- Keep the command window visible after startup.
- Do not kill existing processes or modify Lakomics library data.
- Add no package or custom launcher executable.

---

### Task 1: Create and verify the live development shortcuts

**Files:**
- Create: `C:\chatgpt\Lakomics Live Dev.lnk`
- Create: `%USERPROFILE%\Desktop\Lakomics Live Dev.lnk`

**Interfaces:**
- Consumes: `C:\Windows\System32\cmd.exe`, `C:\chatgpt\app\package.json` script `tauri`
- Produces: two equivalent Windows shortcuts that invoke `npm.cmd run tauri dev`

- [ ] **Step 1: Record existing shortcut metadata**

Use `WScript.Shell.CreateShortcut()` to read the target, arguments, working directory, and description of `Lakomics.lnk` and `Lakomics (Debug).lnk`. Keep the values for the final unchanged comparison.

- [ ] **Step 2: Create both shortcuts**

Create each shortcut with these exact properties:

```text
TargetPath       = C:\Windows\System32\cmd.exe
Arguments        = /k "title Lakomics Live Dev && npm.cmd run tauri dev"
WorkingDirectory = C:\chatgpt\app
Description      = Lakomics live development mode
IconLocation     = C:\chatgpt\app\src-tauri\target\debug\lakomics.exe,0
```

If the debug executable is absent, omit `IconLocation`; the shortcut must still work.

- [ ] **Step 3: Verify shortcut metadata**

Read both new shortcuts through `WScript.Shell.CreateShortcut()` and assert that `TargetPath`, `Arguments`, `WorkingDirectory`, and `Description` exactly match the values above.

- [ ] **Step 4: Verify existing shortcuts were not changed**

Read `Lakomics.lnk` and `Lakomics (Debug).lnk` again and compare their metadata with Step 1.

- [ ] **Step 5: Launch the desktop shortcut**

Open the desktop shortcut once. Confirm the visible command window runs `npm.cmd run tauri dev`, the Lakomics development window opens, and the command window remains visible.

- [ ] **Step 6: Stop only the verification session**

Close the development command window created in Step 5. Do not close a pre-existing Lakomics session and do not alter library data.

- [ ] **Step 7: Report delivery paths and behavior**

Report both shortcut paths and explain that saving React/CSS changes hot-reloads the window while Rust changes trigger a development rebuild and app restart.
