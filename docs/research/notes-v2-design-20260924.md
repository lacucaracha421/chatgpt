# Notes v2: checklists, colours, Markdown — design (2026-09-24)

Status: Accepted 2026-09-24, extended 2026-09-25 (see "Scope additions"); implementation started 2026-09-25. Scope comes from the user decision on
2026-09-24 (`docs/roadmap/lakomics-backlog.md:195`): checklist notes (items can be
checked and reordered), note colours, and Markdown rendering, on PC and mobile, within
the existing encrypted Notes sync (ADR-0035).

ADR-0035 lists "서식 편집" as out of scope (`docs/adr/0035-encrypted-personal-notes.md`,
"동기화와 복구"). Accepting this design means writing a short ADR that clarifies ADR-0035.
It would keep the key, envelope, and server contract as they are and add a versioned plaintext
schema.

Assumptions are marked **[A]**.

## 1. Current state (evidence)

### Server: stores only ciphertext
- `server/lakomics-api/notes.py:14-18`: `Envelope` is `{version: 1..1, nonce: 24 hex, ciphertext: ≤600000 hex}` with `extra="forbid"`. The server never sees titles, bodies, or note types.
- `notes.py:32-36`: the table holds `vault, id, revision, operation_id, payload, sequence, updated_at`.
- `notes.py:61-85`: PUT uses CAS on `expectedRevision`. A replayed `operationId` returns the stored row, or 409 if the payload differs (`:69-72`). A revision mismatch returns 409 "Note changed on another device" (`:74-75`). Each accepted write bumps a global `sequence`.
- `notes.py:49-59`: GET returns the changes after a cursor, 50 per page at most.
- **Consequence:** schema changes inside the ciphertext need no server change as long as the envelope stays `version: 1` and a note stays under 600000 hex (about 300 KB plaintext).

### Crypto (identical on PC and Android)
- PC: `_tools/app/src-tauri/src/library/notes.rs:122-164`. The AAD is `lakomics-notes:1:<sha256(key)>:<id>` (`:122-124`). `open` rejects `version != 1` (`:145`). It deserialises into `Content` and enforces title ≤200 chars and body ≤128 KiB (`:160-163`).
- Android: `android/src/com/lakomics/mobile/NotesCrypto.java:14-18` uses the same AAD. `NotesRepository.java:39-51` seals and opens. `validate` requires `title, body, pinned, deleted, createdAt, updatedAt` (`:47-51`).
- The cross-platform test vector is at `notes.rs:721-725`.

### Plaintext model (v1)
- `Content = {title, body, pinned, deleted, createdAt, updatedAt}` (`notes.rs:29-38`).
- The mobile type is the same (`_tools/app/mobile-client/Notes.tsx:9`), and so is the PC type (`_tools/app/src/notes/store.ts:3`).
- There is no schema/version field inside the plaintext.

### How saves lose unknown fields today (important for compatibility)
- PC: `notes_save_with_key` builds a new `Content` from `Draft {id,title,body,pinned,deleted,expectedRevision}` (`notes.rs:78-86`, `:350-357`). Serde ignores unknown fields on read, because there is no `deny_unknown_fields` at `notes.rs:29`. It also drops them on the next save.
- Android: `save` builds `content` only from draft keys (`NotesRepository.java:67`). The WebView sends only `title/body/pinned/deleted` (`Notes.tsx:27`).
- **Result:** a deployed (pre-v2) client that edits a v2 note silently strips checklist items and colour. Opening the note or syncing it is harmless. Only a local edit re-seals the note. The design has to tolerate this, because clients already installed cannot be changed.

### Sync, pending state, and conflicts
- PC local table: migration `_tools/app/src-tauri/migrations/0043_notes.sql` has `payload, local_revision, remote_revision, operation_id, dirty, conflict`.
- PC pull: `notes_merge` (`notes.rs:407-435`). If the local row is dirty with a different operation, it stores the remote row in the `conflict` column and does not overwrite (`:422-430`).
- PC push: dirty rows skip conflicted ones (`:484`). An edit made while a PUT is in flight stays dirty (`:510-511`).
- PC resolution is manual: "내 내용 보관 후 서버 버전 불러오기". It copies local into a new note titled "(복사본)" and takes the remote version (`notes.rs:368-405`, UI `NotesView.tsx:60`).
- Android pull: `apply` (`NotesRepository.java:72-80`). A pending local edit against a different remote operation is **automatically** copied to a new UUID flagged `conflict`, and the remote version wins (`:75-78`).
- Android push: a 409 on PUT is skipped until the next pull (`:96`).
- Merge today is whole-note, keeping both copies. Nothing is merged at field or item level, and no common ancestor (base) is stored on either client.
- UI states: the PC store queues local writes (`store.ts:34-54`) and shows 편집 중 / PC에 저장 중 / 동기화 대기 / 충돌 확인 필요 (`NotesView.tsx:51`). Mobile debounces saves by 500 ms, then syncs (`Notes.tsx:43`), and shows 저장 대기 / 동기화 대기 / 동기화됨 (`Notes.tsx:55`).

### Rendering surface and security context
- The repo has no Markdown or sanitiser dependency (`_tools/app/package.json:23-35`) and no `dangerouslySetInnerHTML` in `src/` or `mobile-client/`.
- Android WebView CSP: `img-src 'self' https: data: blob:` and `connect-src https:` (`MainActivity.java:47`). A remote image in a note would load and leak that the note was opened.
- The WebView has a native bridge that includes `notesUnlock`/`notesSave` (`MainActivity.java:96-99`). Script injection through note content would reach the Notes key operations, so XSS here is critical.
- PC CSP: `_tools/app/src-tauri/tauri.conf.json:25`.
- External links already have safe paths: Android `openExternal` accepts only http/https (`MainActivity.java:163`), and the PC has `@tauri-apps/plugin-opener`.
- Palette source: `CLASSIFICATION_COLORS` (`_tools/app/src/classification/classificationAppearance.ts:60-80`). The mobile client already imports from `../src/classification/…` (`mobile-client/ClassificationAssignmentEditor.tsx:7`).

## 2. Data model (inside the encrypted payload only)

```jsonc
{
  "schema": 2,                    // absent = v1
  "type": "text" | "checklist",   // absent = "text"
  "title": "…", "body": "…",      // body: Markdown for text notes; for checklists a
                                  // derived fallback (see 3.2), never edited directly
  "color": "amber" | null,        // palette key; unknown key renders as default
  "items": [                      // checklist only
    {"id": "uuid", "text": "…", "checked": false, "order": "a0"}
  ],
  "pinned": false, "deleted": false, "createdAt": "…", "updatedAt": "…"
}
```

- **Stable item ids:** UUID v4, created by the device that adds the item.
- **Order:** a fractional-index string per item. Clients sort by `(order, id)`. A move changes only the moved item's `order`, so concurrent moves and edits of other items merge. **[A]** A small in-house fractional-key helper, about 40 lines, shared as TS for the UI and ported to Rust/Java for the merge. Arrays are not reordered in place.
- **Colour:** about 8 keys, a subset of `CLASSIFICATION_COLORS` (for example red, orange, amber, green, teal, blue, indigo, plus one neutral), or `null`.
  - Cards use `color-mix()` with `--color-surface`, so the dark theme stays readable.
  - The swatch values come from the palette. They are not hard-coded in Notes.
  - A key the client does not know renders as `null` and is **preserved** on save.
- **Markdown:** always on for text notes. There is no per-note flag.
  - The stored text does not change. Rendering happens only in view mode, and the raw text is always what gets edited.
  - A flag would be lost whenever an old client edits the note, and v1 notes would need a decision anyway.
  - Risk: a legacy note containing `#` or `*` renders differently. This is display only, and nothing is lost.
- **Limits** (all validated in Rust, Java, and the UI):
  - Title ≤200 chars and body ≤128 KiB (unchanged).
  - ≤500 items, each item ≤1000 code points.
  - Serialized plaintext ≤256 KiB, which stays below the 600000-hex envelope cap.
  - A checklist's fallback body counts toward the same 128 KiB limit.

## 3. Compatibility

### 3.1 Preserve what you do not understand
- PC: add `#[serde(flatten)] extra: serde_json::Map<String, Value>` to `Content`. Save starts from the opened old content and overwrites only the known fields.
- Android: `save` starts from `open(v,id,old)` and `put`s the known keys over it.
- The WebView and PC drafts send only the fields they edit. Native code keeps the rest.
- **Schema guard:** if `schema` > the highest schema the client supports, or `type` is unknown, the editor opens **read-only**. It shows `title` and `body` (the fallback) and a banner saying the note needs a newer app version. Pin, trash, and restore still work, because they are metadata saves that keep the extra fields.

### 3.2 Plaintext fallback for pre-v2 clients
- For every checklist save, a v2 client regenerates `body` as a GFM task list: `- [ ] text` / `- [x] text`, in display order.
- A deployed pre-v2 client therefore shows a readable list in its textarea.
- If that client edits and re-saves the note, the result is a v1 note (`schema`, `type`, `items`, `color` removed). Its body holds task-list text.
- A v2 client displays such a note as a text note. Because text notes render Markdown, including task lists, it still *looks* like a checklist. A one-tap "체크리스트로 변환" parses the task lines back into items.
- **What is lost:** item ids, which only affects merges, and the colour. There is no data loss. **[A]** This is acceptable for a single-user, two-device setup. Rollout (section 8) keeps the window short.

### 3.3 Envelope and server
- The envelope stays `version: 1` and the AAD is unchanged.
- The server, the `.lakonotes` backup format (`notes.rs:88-97`), and the recovery key are untouched.
- No server deployment is needed.

## 4. Conflict and merge rules

Today, concurrent edits always produce two copies (section 1). v2 adds automatic 3-way merging where it is safe. Anything else falls back to the existing both-copies path.

1. **Store a base.** Each client keeps the last server-acknowledged envelope per note (`base_payload`). It is set when a remote row is applied cleanly (`notes.rs:433`, `NotesRepository.java:79`) and when a PUT is acknowledged (`notes.rs:510`, `NotesRepository.java:99`).
   - PC needs migration 0095 (`ALTER TABLE notes ADD COLUMN base_payload TEXT`). This is a local library schema change: it follows the usual pre-migration backup and **needs user approval before it runs on the real library**.
   - Android: `ALTER TABLE note_items ADD COLUMN base_payload TEXT` in `NotesRepository` init.
2. **Trigger.** A pull finds a local pending edit with a different `operationId`: PC `notes.rs:422`, Android `NotesRepository.java:75`. Decrypt base, local, and remote.
   - If the base is missing (legacy rows), or any side's `schema` is unsupported, keep today's behaviour.
3. **Scalar fields** (`title`, `color`, `pinned`, `deleted`, `type`): if only one side changed a field, take that side. If both changed it to different values: `pinned`/`color` take the remote; `deleted` takes `false`, so restoring wins; `title` or `type` is an unresolvable conflict.
4. **Text body:** if one side changed, take it. If both changed, the conflict is unresolvable. No line-level text merge in v2. **[A]** A text merge could come later.
5. **Checklist items**, per item id:
   - Added on either side: keep.
   - Deleted on one side and unchanged on the other: delete.
   - Deleted on one side and edited on the other: keep the edited item. Losing text is worse than a resurrected item.
   - Fields `text`, `checked`, and `order` merge independently, with the same one-side rule. Both sides changing `text` differently is unresolvable. `checked` or `order` conflicting takes the remote.
   - Duplicate `order` keys after the merge tie-break by id.
6. **Result.**
   - Merge succeeds: seal the merged content as a new local pending write on top of `remote.revision`. Set base to the remote. Use a new `operationId`, and keep `conflict` clear.
   - Merge fails: fall back to the platform's current behaviour. This design does not change that behaviour. It does recommend unifying it (open question 3).
7. **Shared test vectors.** A JSON fixture file of (base, local, remote, expected) cases, run by both the Rust unit tests and a Java test harness. This follows the existing envelope vector at `notes.rs:721`.

## 5. UI flows

The design language and tokens stay as they are, and nothing new is added to the stack.

### Mobile (touch-first; `mobile-client/Notes.tsx`, `notes.css`)
- **New note:** the FAB opens a small choice between 메모 and 체크리스트. **[A]** Alternatively, a long-press on the FAB creates a checklist.
- **Checklist editor:** each row has a 44 px checkbox, a text field, and a drag handle.
  - Enter adds an item below and focuses it. Backspace in an empty item deletes it and focuses the previous one.
  - Checking an item moves it into a collapsible "완료 N" group at the bottom. **[A]** Alternatively it stays in place.
  - Reorder with pointer events, started by a long-press on the handle only, so scrolling stays unaffected. Autoscroll near the edges. Keep the IME handling around `Notes.tsx:63-77` intact.
- **Editor header overflow menu:** 색상, 체크리스트로 변환 / 텍스트로 변환, 휴지통.
  - Text → checklist: task-list lines keep their checked state. Otherwise each non-empty line becomes an item.
  - Checklist → text: produces a GFM task list.
  - Both are ordinary saves.
- **Colour picker:** a swatch row in the existing `BottomSheet.tsx`.
- **Text notes:** an existing note opens in rendered view, and tapping the text or the edit icon switches to the textarea. A new note opens in edit mode. Tapping a link calls the native `openExternal`.
- **List cards:** colour tint; checklist preview with the first 4 items and a `3/7` count; text preview with Markdown syntax stripped (`Notes.tsx:58` today shows raw text).

### PC (`src/notes/NotesView.tsx`, `store.ts`)
- Same model. The colour and type actions sit in the editor action row (`NotesView.tsx:59`), using the existing Radix dropdown.
- **Keyboard:** the existing Ctrl+N and Ctrl+S (`NotesView.tsx:55`), plus:
  - Ctrl+E: toggle view/edit.
  - Ctrl+Shift+L: convert text ↔ checklist.
  - In a checklist: Ctrl+Enter toggles the focused item, Alt+↑/↓ moves it, Enter adds an item, Backspace on empty deletes.
  - All shortcuts ignore `isComposing`, as the current handler does.
- Drag with pointer events on the handle; no new library.
- **List:** a small colour dot or tint on `.notes-list-item`, and the checklist count in the preview line.

### Drafts across the bridge
- `Draft` (`notes.rs:78-86`) and the mobile `notesSave` payload gain optional `type`, `color`, and `items`.
- Native code validates them, rebuilds the fallback body, and keeps unknown fields (section 3.1).
- `expectedRevision` handling stays exactly as it is.

## 6. Markdown rendering

- **Recommendation:** a small in-house renderer, shared at `_tools/app/src/notes/markdown.tsx` and imported by the mobile client the same way it already imports shared modules.
- It returns **React elements, never HTML strings**. Nothing is inserted with `innerHTML`, so script injection is impossible by construction. That matters because the Android WebView exposes the Notes bridge.
- **Supported subset:**
  - Headings (#–###), paragraphs, and line breaks.
  - Bold, italic, strikethrough, and inline code.
  - Fenced code blocks (no highlighting).
  - Ordered, unordered, and task lists.
  - Blockquotes and horizontal rules.
  - Links, only `http:`/`https:`.
- **Excluded:**
  - Raw HTML, which renders as literal text.
  - Images, which would leak remote requests (the Android CSP allows `https:` images) and are outside the notes scope.
  - Tables. **[A]** Tables could come later.
  - Autolinked bare URLs. **[A]** These are cheap to add.
- **Links:** rendered as buttons or anchors with `rel="noreferrer noopener"` and an onClick that calls `openExternal` or the plugin opener. The WebView never navigates to them; `shouldOverrideUrlLoading` already blocks that.
- **Size:** about 250–350 lines plus tests.
- **Alternative:** `marked` or `markdown-it` plus `DOMPurify`. That is more complete, but it adds two dependencies, which needs user approval, and depends on `dangerouslySetInnerHTML` plus sanitiser correctness. Not recommended.
- **Task lists in text notes:** tapping a rendered checkbox could rewrite that line in the body. This is optional; see open question 4.
- **Search and preview:** a `plainText(note)` helper strips syntax and, for checklists, joins item text.
  - Search matches title, body, and item text. It replaces the `${title}\n${body}` filters at `NotesView.tsx:45` and `Notes.tsx:52`.
  - Previews use the same helper.

## 7. Performance

- Android decrypts every note on each `state()` call (`NotesRepository.java:60`). The payload grows only by the items, so this is fine for hundreds of notes. **[A]** The expected count is under 1,000.
- Render Markdown only for the open note, memoised on `body`. List previews use the cheap `plainText` helper, not the renderer.
- Rapid checkbox taps are saves like any other. They go through the existing 500 ms debounce on mobile and the serialized queue on PC, so the number of sync writes stays the same.
- Merges run only on conflict, so there is no steady-state cost.

## 8. Rollout order (neither client ever breaks the other)

The server needs nothing in any release.

1. **Release A — PC and APK, small:**
   - Preserve unknown fields on save (section 3.1).
   - Add the schema/type read-only guard.
   - Add the `base_payload` column and start recording it.
   - Add the Markdown renderer for text notes (display only, so no data risk).
   - Still writes v1-shaped notes.
2. **Release B — PC first, then APK:** v2 writing (checklists, colours), the merge, and the new UI.
   - While only the PC is on B, an APK on A shows v2 notes read-only with the task-list fallback. It cannot damage them.
   - PC first because Rust unit tests and the fixture harness catch merge bugs before any device is involved.
3. **Deployed pre-A clients** (an old APK or old PC build that never updates) are the only data-degrading case. Their edits demote checklists to Markdown task-list text notes (section 3.2), without losing text. Tell the user to update both devices before creating checklists.

## 9. Testing plan

- **Rust** (`library/notes.rs` tests):
  - Round-trip preserves unknown fields.
  - The schema guard refuses content edits.
  - The fallback body is generated.
  - Limits are enforced.
  - A v1 note stays byte-compatible in shape.
  - The shared merge fixtures pass.
  - A two-device mock server (`notes.rs:624` pattern) shows concurrent checklist edits merging with no conflict copy.
- **Java:** the same fixtures, plus a new cross-platform vector: a v2 note sealed by the PC and opened on Android, and the reverse.
- **Frontend (vitest)**, extending `NotesView.test.tsx` and `store.test.ts`, plus mobile tests:
  - Markdown renderer cases, including hostile input: `<script>`, `javascript:` links, `<img onerror>`, and deeply nested lists for performance.
  - Checklist add, check, reorder, and convert.
  - Colour picker.
  - Search over items.
- **Native acceptance** (separate evidence levels):
  - PC Tauri dev build: edit and sync.
  - Galaxy Tab APK: drag-reorder with the IME open, checkbox tap targets.
  - A real server round trip between the two devices with an offline concurrent edit.
  - A release A APK viewing a release B note.
- The real notes vault is production data. Test with a test vault or key, or with user approval.

## 10. Open questions

1. **Markdown always-on for text notes (recommended) or a per-note toggle?** Always-on is simpler and survives old-client edits. The cost is that legacy notes containing `#` or `*` render differently.
2. **Checked items:** move them to a collapsible "완료" group, or leave them in place?
3. **Unify unresolvable-conflict handling?** Android auto-copies and PC asks the user. Choose one behaviour for both.
4. **Rendered task-list checkboxes in *text* notes:** should they be tappable, rewriting the body? Or read-only, with the user converting to a checklist for interaction?
5. **Palette size and names:** 8 colours or fewer, and whether a colour tints the whole card or shows as a dot or stripe.
6. **ADR:** confirm that a short ADR clarifying ADR-0035 should record the v2 schema, the fallback, and the merge rules.
7. **Approvals:** the PC library migration 0095 (`base_payload`) needs approval before it runs against the real library. No new npm, Gradle, or Cargo dependency is proposed.
8. **Base-less alternative:** per-item `updatedAt` last-writer-wins with item tombstones in the payload. It avoids the base column but depends on device clocks and payload growth. Rejected in favour of the 3-way merge unless the migration is unwanted.

## User decisions (2026-09-24)

All recommendations accepted:
1. Text notes always render Markdown.
2. Checked checklist items move into a collapsible "완료" group.
3. An unresolvable edit collision keeps both copies automatically on PC and mobile (today's mobile behaviour).
4. Task-list checkboxes in rendered text notes can be ticked (rewrites that line).
5. Eight colours; the colour tints the whole card lightly.
6. Record this in a short ADR amending ADR-0035's "formatting out of scope".
7. PC migration 0095 (last-synced base per note) is approved for implementation; running it on the real library still happens only through a normal app update.

Additional requirement: the user does not know Markdown syntax. Add a small help button in the editor (PC and mobile) that opens a short Korean cheat sheet: headings (`#`), bold (`**굵게**`), italic (`*기울임*`), lists (`-`, `1.`), task items (`- [ ]`), links (`[텍스트](주소)`), quotes (`>`), inline code, and a line break note. Keep it one screen, touch-friendly, with each example shown next to how it renders.

## Scope additions (user decisions, 2026-09-25)

Reference app: Google Keep. Storage stays as it is: every note remains end-to-end encrypted under ADR-0035; the user chose to keep that and add a visibly locked "암호 메모" instead of splitting plaintext and encrypted storage. Migration number: `0095` is taken (`0095_authority_intent_drops.sql`), so the base column is **`0096_notes_base_payload.sql`**.

Added to v2 (all inside the encrypted payload; no server change):
1. **Labels.** `labels: ["…"]` (≤20 per note, each ≤40 chars, NFC, case-insensitive unique). A label list/filter on PC (side list) and mobile (chips). Merge: 3-way per label (added on one side → added; removed on one side and untouched on the other → removed).
2. **Search.** Client-side over decrypted title, body, checklist item text and labels, in memory only. Secret notes match by title only.
3. **Archive.** `archived: bool` scalar; archived notes leave the main list and appear under 보관함. Merge: if both changed, `false` wins (like `deleted`).
4. **Secret notes (암호 메모).** `type: "secret"` with `fields: [{id, label, value, order}]` (≤200 fields; label ≤100, value ≤4000 code points) plus an optional free-text `body`. Merge per field id like checklist items (value conflict on the same field → unresolvable → keep both copies).
   - List shows the title and a lock icon only; body, fields and labels are hidden and excluded from search except the title.
   - Opening requires a local unlock: PC a 4–8 digit PIN; Android fingerprint (BiometricPrompt, API 28+, no new dependency) or the PIN. The PIN is per device: a salted PBKDF2 verifier stored with the device's other local secrets (PC OS credential store; Android SecureSettings), never synced. First use asks to set it.
   - Values display masked (`••••`) with 보기 (reveal for 10 s) and 복사 buttons; copying never logs the value, and on Android marks the clip as sensitive (`ClipDescription.EXTRA_IS_SENSITIVE`).
   - Re-locks after 5 minutes of inactivity, when the note is closed, and when the app goes to the background (mobile) or the window is hidden (PC).
   - Pre-v2 clients see the fallback body: `label: value` lines, so a pre-v2 edit never loses data (same rule as checklists, section 3.2).
5. **Locked keyring prompt (PC, Linux).** When the user opens Notes and the Secret Service collection is locked, request an interactive unlock (the system password dialog) instead of only showing the locked state. Background readers still never prompt. Once unlocked, the key stays available for the session.

Deferred: image attachments, reminders, handwriting, grid/list toggle.

Rollout is unchanged: Release A (PC and APK read v2, preserve unknown fields, base column), then Release B (PC first, then APK) for writing the new types, labels, archive and secret notes.

## PC implementation deviations and details (2026-09-25)

Recorded by the PC implementation; the shared fixtures in `tests/fixtures/notes-v2/` (`merge-vectors.json`, `payload-examples.json`) are the contract for Android.

1. **Secret-note free text is `memo`, not `body`.** `body` of a secret note is always the derived fallback (`label: value` lines, then a blank line and the memo), exactly like a checklist's derived body.
2. **Schema marker only when needed.** A client writes `schema: 2` only when a note uses a v2 feature (type, colour, labels, archive, items, fields, memo); a plain text note keeps the exact v1 shape. The PC ships reading and writing together (the Release A/B split is not used on the PC side).
3. **Canonical serialization, fallback order and merge details** are spelled out in `merge-vectors.json` (`rules`). Additions beyond section 4: the checklist fallback lists open items, then checked items; bool fields cannot collide (both sides can only flip to the same value); a type change on one side plus a content change on the other is a collision; a deleted item/field survives only a text/checked (item) or label/value (field) edit on the other side, not a pure move; unknown keys merge with the one-side rule and a collision takes the server value; `updatedAt` is the later of the two; a merge result that breaks a limit keeps both copies.
4. **Colours:** `red, orange, amber, green, teal, blue, indigo, pink`; "기본" is no colour (there is no neutral palette key).
5. **Order keys:** base-62 digits `0-9A-Za-z` compared by code unit, never ending in `0`; the first key is `V`. Appending/prepending steps one digit, so keys grow about one character per ~30 moves to an end; a group is renumbered when neighbours collide or a key would exceed 48 characters. Only the comparison rule matters for interop.
6. **Labels:** the UI normalizes to NFC and trims; the backend validates (≤20, ≤40 chars, no control characters, no surrounding spaces, case-insensitive unique by lower-casing) but does not re-normalize, because the Rust side has no Unicode normalization dependency.
7. **Keep-both flag:** migration 0096 also adds a local `conflict_copy` column (never synced), shown as "사본" with a dismissible notice, matching Android's local conflict flag. Rows already holding a stored server version from a pre-v2 build keep the old manual "내 내용 보관 후 서버 버전 불러오기" action until their next remote change, which then takes the keep-both path.
8. **Save protocol:** a PC save sends only the fields it edits; absent fields keep the stored value and `color: null` clears the colour. Conversions are text ↔ checklist only; a secret note cannot change type and cannot be created from another type.
9. **Secret session:** one PIN unlock opens all secret notes of the library for the session; while locked the backend withholds body, memo, fields, labels and unknown fields of secret notes from the UI. Moving directly from one secret note to another keeps the session; closing a secret note to anything else, 5 idle minutes (also enforced in the backend), hiding the window (visibility change or closing to the tray) and leaving Notes lock it. UI activity refreshes the backend session at most once a minute. A secret save refused because the session closed keeps its draft and shows the PIN prompt; locking never hides a draft that is still queued. After five wrong PINs entry is blocked for 30 s, then 1 min, 5 min, 15 min, 30 min and 1 h per further miss; the counter is kept in the library's local notes state so a restart does not reset it. A forgotten PIN is reset with the recovery key; once a PIN exists, showing the recovery key needs an open PIN session (or the PIN). A copied value is cleared from the clipboard after 30 s if it is still there.
10. **Markdown renderer location:** `_tools/app/src/shared/markdown/` (from commit 7c5954b), not `src/notes/markdown.tsx`.
11. **Queued saves after a pull (rebase).** A pull that replaces a note under the editor keeps the replaced local payload in `notes_revisions` (migration 0096, last 20 local revisions per note). A save sent against that older local revision is three-way merged (base = that payload, local = the draft applied to it, other = the current note); only an unresolvable collision keeps the draft as a separate conflict copy, and the editor then continues in that copy. The UI rebases a newer queued draft onto the save's result field by field. A draft's `expectedRevision` is therefore its base revision, and a queued note keeps it on purpose.
12. **Forward compatibility.** Payloads are decoded to JSON first. A newer `schema`, an unknown `type`, or any key with an unexpected type or a missing required key makes the note read-only raw: title/body shown, pin/trash/archive/restore patch only those keys (plus `updatedAt`), every other byte kept. A row that does not authenticate is counted as unreadable and hidden instead of failing the vault; a pulled row that does not authenticate is skipped instead of failing the sync. Examples: `payload-examples.json` → `undecodable`.
13. **UI never receives unknown keys** (top level, items, fields); saves restore them from the stored payload by id. The editor checks all limits before queueing and shows a Korean message instead of sending an over-limit draft.

## Android implementation deviations and details (2026-09-25)

Recorded by the Android implementation (0.8.15). It follows the PC rules above and runs the same fixtures (`android/tests/NotesModelTest.java`, run by `android/build.py`).

1. **One shared client store.** The WebView reuses the PC `src/notes/store.ts` `NotesStore` (queue, rebase of a newer queued draft, `copiedTo`, `secretLocked`) with a native transport; saves go to native immediately instead of the old 500 ms debounce. The mobile screen keeps its own sync timers: immediately on open, every minute, and 2 s → 60 s back-off while writes wait; 동기화 and pull-to-refresh sync at once.
2. **Native model port.** `NotesModel.java` ports `model.rs` plus the decode/view/draft rules of `notes.rs`; it is platform-free (the repo's strict `Json` reader and its own writer, not `org.json`). The plaintext parser allows nesting up to 128 levels; deeper payloads count as unreadable.
3. **Local store.** `note_items.base_payload` (merge base) and `note_revisions` (last 20 replaced payloads per note, for the stale-save rebase) are added in `NotesRepository` init. The existing Android `conflict` column is the local keep-both flag (shown as 사본, dismissible); Android never has the PC's legacy manual-resolution state, so `conflict` is always false in the view. A pulled server version keeps an existing 사본 flag, as the PC does.
4. **Save echo after a keep-both copy** reports the original row's real `pending` flag (the PC reports `false`).
5. **Secret notes.** One device PIN (4–8 digits, PBKDF2-HMAC-SHA256, 310,000 iterations, 16-byte salt, same verifier shape as the PC) is stored encrypted with the Android Keystore key in its own preferences file; the escalating failure counter survives restarts. Fingerprint uses the framework `BiometricPrompt` (API 28+, `BIOMETRIC_STRONG` on API 30+, negative button "PIN 입력"); it needs a PIN to exist and is offered at once when a locked secret note opens. A successful fingerprint does not reset the PIN failure counter and is not blocked by a PIN lockout (the system applies its own biometric lockout). The session lives only in native memory: 5 idle minutes, closing the note, leaving the Notes tab, and `onStop` (native locks and emits `lakomics-notes-locked`; the page then redacts). Copy goes through native `notesCopySecret`: the clip is marked `EXTRA_IS_SENSITIVE` (the literal extra key below API 33) and cleared after 30 s if its timestamp is unchanged; while the app is in the background the check waits for window focus. The recovery key can be shown from the Notes list (복구키 보기) and needs the PIN session once a PIN exists.
6. **Bridge limits.** Notes requests may carry up to 1 MiB of JSON (other requests keep the 64 KiB limit), so a 128 KiB body or a full checklist can be saved.
7. **Editor on touch.** Text notes open rendered; tapping the text edits the source, and leaving it (tapping elsewhere in the note, Back, or the keyboard closing) returns to the rendered view. The source field grows with its text inside the scrolling editor, and the editor scrolls the caret above the keyboard when the visible viewport shrinks and while typing. Checklist rows drag after a 250 ms press on the handle (a mouse or pen drags at once) and auto-scroll near the edges. Colour is a sheet opened from a circle showing the current colour; 보관 is in the ⋯ sheet next to 휴지통; text ↔ checklist is a direct icon button; labels filter the list as chips; 보관함 and 휴지통 are sub-screens.
