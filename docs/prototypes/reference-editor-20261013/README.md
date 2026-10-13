# Reference editor: quiet person check and reinforcement (2026-10-13)

Status: proposal, not accepted. Mockup: `index.html` (loads the app's real `fonts.css`, `tokens.css`, `shared-base.css`, `controls.css`, `chrome.css`, `CharacterManagement.css`, `SeriesBrowser.css`; placeholder artwork only).

User item 10 (2026-10-13): the "필요한 인물만 확인" button in the character info / reference editor always arrives late; could 추천으로 보강 happen quietly; could the person-detection confirmation be a quiet indicator instead of an interruption?

Screen: `characters/CharacterRegistry.tsx` inside the 320 px `AnchoredPanel` opened from the series bar pencil (`SeriesBrowser.tsx`), with `ReferenceRegionChoices.tsx` (person choices) and `ReferenceCandidateDialog.tsx` (recommendations).

## Why the button is late

`ReferenceRegionChoices` renders `null` until the region inspection returns (`showSection` is false while `current` is null). Then a button row appears under the strip, the tiles get ivory "!" marks, and the shortfall line appears or changes wording. Any change to the reference list restarts the inspection from nothing. The series screen already runs the same inspection for the pencil "!", but a reopened panel waits again after a reference change. The fix is a reserved place plus reuse of the last result, not only a faster call.

## Recommendation

### Goal 1: present from the first paint

- The heading row `레퍼런스 12/25` gets a **status slot at its right**, always rendered at the compact control height (28 px), so nothing below it moves.
- Slot states: empty (first 400 ms) → `인물 확인 중` (faint meta, shared delayed-busy helper, held so it never blinks) → `인물 선택 N` (compact quiet button that opens the existing chooser at the first one; replaces "필요한 인물만 확인") or `사용 12 · 인물 영역` (muted; `인물 영역` replaces "인물 영역 조정") or `확인 실패 · 다시 시도`.
- Keep the last inspection per character for the session (keyed by reference id + content hash + region binding), paint it immediately on reopen, and refresh silently. Only new or changed references count as "checking".
- The shortfall hint line exists from first paint with the raw count; only its number updates.

### Goal 2: reinforcement without the modal

Two options are in the mockup:

- **A, 자동 보강 (more automatic).** The PC adds qualifying suggestions to the learned references by itself. The editor shows one meta line under the strip, `3장 보강됨 · 되돌리기`. Hovering it outlines those tiles. 되돌리기 removes them all in one step, and each ✕ removes one. Both are remembered as removals (existing exclusion rule), so a rejected image never comes back.
- **B, 인라인 추천 (conservative).** Suggestions appear as dimmed ghost tiles with a plus badge after the real tiles, fetched together with the inspection and faded in by the arrival rule. One click adds one, and `모두 추가` adds all. They join the draft and are written by the panel's own 저장.

**Recommended: hybrid.** Use A for suggestions that meet every condition below and B ghost tiles for the rest (two-person or undetected images). The 추천으로 보강 button and the modal leave the editor. The modal stays for first setup (manual-only characters with `initialize` mode, folder conversion in `FolderCharacterRegistration`).

Silent application is acceptable only when **all** of these hold:

1. The user put the image into this character by hand. This is already the candidate pool: `origin='manual'`, learning not disabled.
2. No other character is on the image, it is not excluded, and it was never removed from this character's references. This is already filtered.
3. The detector found **exactly one person**, and that box is the crop. Today this is safety tier 0, which is ranked first but not required. A requires it.
4. It is not a near-duplicate of an existing reference. A needs a minimum perceptual distance cut-off on top of the diversity ranking.
5. Automatic recognition is on and the character is not manual-only, so A only adds learned references and never does first setup.
6. At most 4 per run, within the 25 limit. A never removes or replaces anything, and the existing revision/hash check must pass.

Past images are still not re-analysed automatically, so a wrong reference affects only new recognition until it is removed.

### Goal 3: quiet marker, clear blocked save

- One marker on tiles: a 20 px square scrim badge with an icon only. A person icon means "needs a person". An eye-slash plus a dimmed image means "cannot be used". It replaces the ivory "!", because ivory is not a warning colour. `aria-description` keeps the full status. Marks fade in (140 ms) and are kept through re-checks.
- The count sits in the heading slot. On the series bar, the pencil's red "!" becomes a neutral corner count (shared `CountBadge` corner).
- Blocked save (an image shared with another character and no person chosen; the backend rule stays): the footer status line names it in text colour (`레퍼런스 7 · 인물 선택 후 저장`), not red. 저장 stays enabled, and pressing it opens the chooser on that reference and scrolls to it instead of showing a red error after a failed save. Real failures still show the one-line error.

## Decisions for the user

1. **Reinforcement:** hybrid (recommended), A only, or B only?
2. **When A runs:** in the background right after the user puts images into a character by hand (recommended; the editor shows the line on next open), or when the editor panel opens?
3. **How long the `N장 보강됨 · 되돌리기` line stays:** until the panel is saved or closed once after being seen (proposed), or for a fixed period (e.g. 7 days)? Should `관리` keep a short "recent automatic additions" history?
4. **Run cap:** 4 per run (proposed), or fill only up to the 6-reference threshold?
5. **Blocked save:** keep 저장 enabled and jump to the chooser (proposed), or disable 저장 while a shared image has no person?

## Implementation notes (for the controller)

- Goals 1 and 3 are frontend-only: `CharacterRegistry.tsx` (heading slot, tile badges, footer status via the host), `ReferenceRegionChoices.tsx` (always mounted, with no `null` return while inspecting; the chooser opens from the slot or a tile), a session cache in `useReferenceRegionInspection`, and `SeriesBrowser.tsx` (pencil corner count, footer status, 저장 → focus request instead of the error-regex path).
- Option A needs a backend filter for the safe tier (exactly one detected person, a distance cut-off, a cap) and a trigger. The write itself is the existing `confirm_reference_batch` in `add_learned` mode. Undo is a normal reference removal, which already inserts the exclusion.
- Option B needs the editor draft to carry suggested learned additions (with their regions) into the save. Today the editor save and `confirmReferenceBatch` are separate paths.
- The tablet follows in the same round with the same pieces (`DESIGN.md` §12).
