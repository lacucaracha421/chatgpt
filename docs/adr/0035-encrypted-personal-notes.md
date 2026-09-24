# 개인 메모는 별도 복구키로 암호화하여 동기화한다

Status: Accepted; amended 2026-09-24 (Notes v2: checklists, colours, Markdown, item-level merge; see the amendment at the end)

Clarifies: ADR-0033, Notes domain only. Asset replication authority is unchanged.

2026-09-07 사용자 결정: PC 사이드바의 다시보기 아래에 간결한 메모 목록과 편집기를 추가하고, 서버 연결 인증과 별개의 키가 필요한 암호화를 사용한다.

## 저장과 키

- 메모는 Asset, Album, Works 메타데이터와 별개의 텍스트 도메인이다.
- PC에서 생성한 256-bit 무작위 키와 AES-256-GCM으로 제목, 본문, 고정, 삭제 상태, 작성/수정 시각을 함께 암호화한다. 매 저장마다 무작위 96-bit nonce를 사용하며 버전, vault, 메모 ID를 AAD로 묶는다.
- 로컬 SQLite와 서버에는 암호문만 저장한다. 복호화한 제목/본문은 PC의 메모리에서 편집·검색하며 localStorage에 기록하지 않는다.
- 키는 라이브러리 경로에 대응하는 Windows 자격 증명 저장소에 보관한다. 최초 생성 때 64자리 hex 복구키를 표시하고 별도 보관 확인을 받는다. 같은 PC에서는 자동으로 열리며, 새 PC/이동한 라이브러리에서는 같은 복구키를 등록한다.
- 복구키는 API bearer token과 다르며 서버로 전송하지 않는다. 서버에는 SHA-256(key) vault 식별자, 메모 UUID, revision, operation ID, 변경 sequence/시각, 암호문 크기가 노출된다. 서버와 백업만으로 본문을 복구할 수 없다. 로그인한 PC에서의 악성 코드나 메모리 열람을 막는 기능은 아니다.

## 동기화와 복구

- 로컬 암호문 저장과 dirty 표시를 먼저 완료한다. Cloud 미연결/오류는 성공한 로컬 저장을 취소하지 않는다.
- 기존 Cloud 설정과 인증을 사용하되 Notes 전용 GET/PUT API로 양방향 교환한다. React에 bearer token을 전달하지 않는다.
- 서버 expectedRevision CAS와 operation ID 재시도로 유실 응답을 처리한다. 변경 충돌은 자동 덮어쓰기 대신 로컬 복사본과 서버 버전을 모두 보존하는 선택을 제공한다.
- 삭제는 암호화된 tombstone이며 휴지통에서 복원할 수 있다. 영구 삭제, 첨부, 키 교체는 이번 범위에 포함하지 않는다. Formatting (checklists, colours, Markdown) was originally out of scope here; it is now in scope under the 2026-09-24 amendment at the end, which also changes how unresolvable conflicts are handled.
- `.lakonotes` v1 백업은 암호문과 식별자만 담으며 같은 키로 불러오면 새 ID의 메모를 추가한다. 손상/다른 키 백업은 전체 가져오기를 거부한다. 현재 파일 크기는 64 MiB까지다.
- 전체 라이브러리 SQLite 백업에도 암호화된 메모가 포함되지만 키는 포함되지 않는다. 전체 DB 복구는 당시 메모 상태도 복원하므로 최근 내용은 별도 메모 백업으로 보관한다.
- 최초 성공한 동기화 서버 주소에 바인딩한다. 임의 서버 전환으로 revision 의미가 달라지는 일을 방지하며 서버 이사는 별도 절차가 필요하다.

## 적용 경계

구현과 격리 fixture 검증은 운영 적용과 구분한다. 운영 적용 전 현재 서버 SQLite의 일관된 백업/복원 경로를 확인하고 백업을 확보해야 한다. API 배포에는 `app.py`와 `notes.py`가 함께 필요하다. 서버 startup은 Notes 테이블만 추가하며 PC는 기존 사전 마이그레이션 백업 절차 후 스키마 43을 적용한다. 실제 라이브러리 마이그레이션과 서버 배포는 각각 사용자의 명시적 승인이 필요하다.

Windows 자격 증명 저장·재실행, 네이티브 파일 대화상자, 종료 중 저장, 실제 서버 왕복은 네이티브/운영 수용 단계에서 확인한다. 코드·브라우저 fixture 통과를 이 단계의 완료로 간주하지 않는다.


## Linux credential backend clarification (2026-09-08)

Linux에서는 동일한 Notes 키를 GNOME Keyring 등 Secret Service의 기본 영구
저장소에 보관한다. Windows Credential Manager 구현과 Notes 암호문/복구키
형식은 그대로 유지한다. OS를 이동할 때는 원래 복구키를 다시 등록하며 키를
라이브러리 파일이나 평문 설정으로 옮기지 않는다. 키링이 없거나 잠겼으면
명시적인 오류로 종료하고, 백그라운드 조회는 키링 잠금 해제를 시도하지 않는다.


## Amendment (2026-09-24): Notes v2 (checklists, colours, Markdown)

User decision (2026-09-24), accepting every recommendation of [`docs/research/notes-v2-design-20260924.md`](../research/notes-v2-design-20260924.md) (see its "User decisions" section). Encryption, key handling and the sync transport above are unchanged.

### Unchanged

- AES-256-GCM encryption, the AAD, the separate recovery key, its credential-store storage and the `.lakonotes` v1 backup format.
- The server stores only ciphertext and still sees only the vault id, note id, revision, operation id, sequence, time and ciphertext size. The note type, colour and item count are inside the ciphertext.
- The outer envelope stays `version: 1`; no server change or deployment is needed.

### Added content (inside the encrypted payload only)

- A plaintext `schema: 2` marker (absent means v1) and a note `type` of `text` (default) or `checklist`.
- **Checklist notes:** items with stable UUIDs, a checked state and a fractional-index order key. Items can be added, checked and reordered; checked items move into a collapsible "완료" group.
- **Colours:** eight palette keys taken from the existing classification palette, or none. A colour tints the whole card lightly and stays readable in the dark theme.
- **Markdown:** text notes always render Markdown in view mode; there is no per-note toggle and the stored text is what is edited. Rendering uses an in-house renderer that builds DOM/React elements only: no HTML string injection, raw HTML shown as literal text, no images, links limited to `http:`/`https:` and opened externally. Task-list checkboxes in a rendered text note can be ticked and rewrite that line.
- **Markdown help:** the editor on PC and mobile has a help button that opens a one-screen Korean cheat sheet showing each syntax next to its rendering.
- Limits: title ≤200 chars and body ≤128 KiB as before; ≤500 items of ≤1000 code points each; serialized plaintext ≤256 KiB.

### Compatibility

- **Preserve unknown fields:** PC and Android saves start from the decrypted stored content and overwrite only the fields they edit, so fields a client does not understand survive its saves. An unknown colour key renders as none and is kept.
- **Read-only guard:** a note with a newer `schema` or an unknown `type` opens read-only with a notice that a newer app version is needed; pin, trash and restore still work.
- **Plaintext fallback:** every checklist save also writes `body` as a GFM task list (`- [ ] …` / `- [x] …`) so pre-v2 clients show a readable list. If such a client edits the note, it becomes a v1 text note with that task list; no text is lost, only item ids and colour, and a v2 client can convert it back to a checklist.
- Rollout: first ship field preservation, the guard, base recording and the renderer on both clients, then v2 writing (PC first). Both devices should be updated before checklists are created.

### Conflicts and merge

- Each client keeps the last server-acknowledged payload per note as a merge base. PC adds it with local migration 0095 (approved for implementation; it reaches the real library only through a normal app update with the usual pre-migration backup). Android adds the matching column in its notes store.
- When a pull meets a local pending edit, the client runs a three-way merge: scalar fields and each checklist item's text, checked state and order merge independently, taking the side that changed. Deletion against an edit keeps the edited item; restoring beats trashing; a concurrent `pinned`, `color`, `checked` or `order` change takes the server version.
- A merge succeeds only without a true collision; the result is saved as a new local pending write on the server revision.
- **Replaces the "선택을 제공한다" rule above:** an unresolvable collision (both sides changed the title, the type, a text body or the same item's text), a missing base or an unsupported schema keeps both copies automatically on PC and mobile: the server version wins and the local edit is kept as a separate note flagged as a conflict copy. The PC no longer asks the user to choose.
- Rust and Java run a shared set of merge test vectors, alongside a cross-platform v2 encryption vector.
