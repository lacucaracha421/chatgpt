# Lakomics Agent Guidelines

## Core workflow

- Prefer focused, minimal changes that directly address the requested task.
- Investigate the relevant code path before making substantial changes.
- Do not refactor, clean up, revert, or overwrite unrelated code or user changes unless explicitly requested.
- When fixing a bug, prefer the root cause over an unnecessary workaround.
- Do not create commits or push to a remote repository unless explicitly requested.
- Ignore unrelated pre-existing warnings or failures unless they block the requested task.
- Keep explanations concise unless detailed analysis is requested.

## Repository docs

### Issue tracker

이 저장소의 이슈는 GitHub Issues에서 관리합니다. 자세한 내용은 `docs/agents/issue-tracker.md`를 참고하세요.

### Domain docs

코드 탐색 전에 루트의 `CONTEXT.md`와 관련 도메인 문서를 확인합니다. 자세한 내용은 `docs/agents/domain.md`를 참고하세요.

### Implementation guidelines

하드코딩, 공통 UI, Module 설계 규칙은 `docs/agents/implementation.md`를 따르세요.

### Visual design

UI를 만들거나 수정할 때는 루트의 `DESIGN.md`를 먼저 읽고 따르세요.
기능 일관성뿐 아니라 정보 밀도, 표면 계층, 타이포그래피와 "AI 생성물처럼 보이는" 장식 패턴도 검토합니다.

## Branch hygiene

- Treat non-`main` branches as temporary working branches.
- After a branch has been merged into `main`, delete the remote branch promptly instead of keeping merged work branches around.
- Do not use long-lived feature, `codex/*`, `agent/*`, or backup branches to preserve old states. Use tags for meaningful snapshots that must be retained.
- `main` is the single source of truth for the current Lakomics app and the bundled `extension/` code.

## Credentials and generated files

- Never commit API keys, access tokens, passwords, generated credentials, extension connection tokens, or other machine-specific secrets.
- Store credentials through the application's credential/settings mechanism or an ignored local environment file appropriate to the owning Module.
- Do not manually edit generated files unless the task explicitly targets generated output.
- Do not commit build artifacts, temporary files, local caches, or machine-specific output unless the repository intentionally tracks that exact artifact.

## Verification

- Start with the single most relevant targeted check and expand only when the change has broader behavioral risk or the targeted evidence reveals a cross-module problem.
- For visual-only CSS, spacing, typography, color, shadow, or animation changes, skip automated tests and production builds unless there is plausible compile or behavioral risk.
- Do not rerun a successful check unless later edits could invalidate it, and do not add tests unless requested or existing coverage would miss a realistic regression introduced by the change.
- Stop once there is sufficient evidence that the requested change works; generic planning, worktree, commit, push, PR, or completion steps are not reasons to run broader checks.

## Works / Collection v2

Works/Collection 기능을 수정하기 전에는
`docs/agents/lakomics-works-handoff-v2.md`를 읽으세요.
시각/상호작용 기준은
`docs/prototypes/lakomics-works-v6-reference.html`을 함께 참고하세요.
프로토타입 코드를 그대로 복사하지 말고 기존 React 구조, 공통 UI, 디자인 토큰에 맞게
시각적 의도와 상호작용만 구현합니다.
Works/Collection에 한해 handoff v2의 최신 결정은 `CONTEXT.md`의 구형 Showcase /
단일 provider 설명보다 우선합니다.
