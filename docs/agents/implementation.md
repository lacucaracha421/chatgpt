# Implementation Guidelines

Lakomics를 구현하거나 수정할 때 다음 규칙을 적용합니다.

## 하드코딩

- 상위 분류 이름, 태그 이름, 저장 경로처럼 사용자가 바꿀 수 있는 값으로 앱 동작을 분기하지 않습니다.
- 반복되는 간격, 색상, 글꼴 크기, 모서리, 그림자, 레이어 순서는 디자인 토큰에서 가져옵니다.
- 포트, 파일 크기 제한, 시간 제한처럼 환경이나 정책에 따라 달라질 수 있는 값은 그 값을 소유한 Module 한곳에서 정의합니다.
- 같은 숫자나 문자열이 우연히 두 번 등장했다는 이유만으로 공통 상수를 만들지는 않습니다. 하나의 의미가 여러 곳에서 반복될 때만 이름을 붙입니다.

## 공통 UI

- 우클릭 메뉴, 팝오버, 대화상자, 알림, 버튼, 입력란은 공통 UI Module의 Interface를 사용합니다.
- 같은 목적의 UI를 새로 만들 때 간격, 색상, 키보드 조작, 포커스 처리, 열고 닫는 동작을 복사하지 않습니다.
- 기존 공통 UI로 표현할 수 없으면 먼저 그 Interface에 필요한 변형을 추가하고, 특정 화면 전용 구현은 실제로 동작이 다를 때만 만듭니다.
- 공통 UI를 바꾸면 그 UI를 사용하는 모든 화면에 같은 결과가 나타나야 합니다.

## Module 설계

- 파일 저장, SQLite, 중복 검사, 썸네일 작업은 라이브러리 Module 안에 숨기고 화면에서 직접 처리하지 않습니다.
- Module은 작은 Interface 뒤에 관련 복잡성을 모으는 깊은 구조로 만듭니다.
- 한 가지 Implementation만 있고 달라질 이유도 없는 코드에는 미리 Adapter나 설정 계층을 만들지 않습니다.
- 두 번째 실제 사용처가 생기기 전에는 추측으로 공통화하지 않습니다. 같은 목적이 확인되면 복사본을 늘리지 말고 공통 Module로 올립니다.

## 변경 확인

- 새 화면을 만들기 전에 기존 공통 UI와 디자인 토큰으로 만들 수 있는지 확인합니다.
- 같은 기능을 복사한 코드가 생기지 않았는지 검색합니다.
- 공통 UI의 키보드 조작, 포커스, 간격과 색상이 기존 화면과 일치하는지 확인합니다.
- 사용자 설정값을 이름이나 위치로 추측하지 않고 저장된 식별자와 자료형으로 처리하는지 확인합니다.

## Review scope

A review is read-only unless its task explicitly authorizes repairs. Follow this scope contract for delegated and inline reviews alike.

1. Establish the requested scope: named commit(s), branch/PR, or the current task including working changes. Record the checkout, HEAD, task paths, and exclusions. For a task review, include relevant committed, staged, unstaged, and untracked changes, not just the latest commit.
2. Select BASE from the user's explicit range, the recorded task-start commit, or the merge-base with the verified integration target. Do not use `HEAD~1` or the current branch's remote-tracking branch as a guessed task base. If BASE is unresolved, inspect the working changes and report the missing committed coverage; do not claim a complete task review.
3. Inspect each applicable layer below, then the combined final tracked state. Staged/unstaged edits can cancel each other, so the combined diff alone is not enough. For an explicitly commit-only review, exclude working changes and say so rather than silently expanding the request.

```text
git status --short --untracked-files=all
git diff BASE HEAD -- <task paths>          # committed task changes
git diff --cached HEAD -- <task paths>      # staged changes
git diff -- <task paths>                    # unstaged changes
git diff BASE -- <task paths>               # combined tracked working state
git ls-files --others --exclude-standard -- <task paths>
```

Replace BASE/HEAD with verified revisions and quote paths for the actual shell; use literal pathspecs for filenames containing wildcard characters. When processing filenames programmatically, use NUL-delimited Git output. Read relevant untracked files directly: ordinary `git diff` does not include their contents. Do not stage files just to review them or read ignored secrets/generated output without a concrete authorized need.

4. Inspect surrounding code and contracts needed to evaluate the changes. Separate task-owned work from pre-existing or concurrent edits; do not silently attribute the whole dirty tree to one agent. Include renames/deletions and their dependent references.
5. Supply the reviewer with the requirements, exact BASE/HEAD, included paths/layers, relevant untracked files, exclusions, and available evidence. Use a supported reviewer if available; otherwise perform the same review inline and disclose that it was not independent.
6. At the end recheck HEAD/status and relevant file contents (or hashes) against the review snapshot. If they changed during review, revisit only the affected findings and evidence. A clean status alone does not prove an unchanged snapshot.

Use read-only Git inspection such as `show`, `log`, and `diff`; no fetch, checkout, worktree creation, index changes, or test-generated writes in a strictly read-only review. Missing historical objects are a coverage limit, not permission to fetch or mutate.

## Verification evidence

`AGENTS.md` owns the risk-based verification policy. For each material claim, retain the command or manual check, scope, observed result, and the revision/files or inputs it covered. This may remain in the task conversation; no permanent test ledger is required.

Reuse inspected evidence while relevant code, dependencies, configuration, fixtures, and runtime assumptions remain unchanged. If any of those invalidate it, repeat only the affected check. Never upgrade a focused test result to a full-suite claim, browser checks to native Tauri acceptance, or fixture success to a real deployment/data acceptance gate. State gaps without manufacturing new tests or silently writing to production data.
