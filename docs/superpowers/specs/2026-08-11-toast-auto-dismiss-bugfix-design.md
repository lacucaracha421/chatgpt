# Toast Auto-Dismiss Bugfix Design

## Goal

Complete the toast auto-dismiss behavior introduced by `b95b5cf` without hiding persistent recovery UI or retaining expired actions.

## Design

- Keep `useAutoDismiss` unchanged and reuse it at each call site.
- In `SettingsView`, auto-dismiss transient operation errors only. A backup-list load error remains visible with its retry button while `backups` is still `null`.
- In `AssetBrowser`, dismissing the message also clears `undoAssetIds`, so an expired undo action cannot reappear on an unrelated message.
- In `ClassificationSidebar`, apply the existing auto-dismiss hook to its message toast.

## Error Handling

Persistent load failures keep their recovery controls. Transient mutation feedback disappears after five seconds. An undo action expires with the toast that presents it.

## Tests

- Verify the backup-list load error and retry button remain after five seconds.
- Verify an expired asset-trash toast cannot attach its undo action to a later message.
- Verify a classification mutation error disappears after five seconds.
- Run the complete frontend test and production build checks.

## Scope

No toast component redesign, new dependency, or unrelated refactor is included.
