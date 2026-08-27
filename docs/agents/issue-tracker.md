# Issue tracker: GitHub

이 저장소의 이슈와 PRD는 GitHub Issues에서 관리합니다. GitHub Issues가 작업 추적의 source of truth입니다.

## 도구 선택

- 사용 가능한 GitHub integration/connector가 있으면 그것을 우선 사용합니다.
- GitHub integration이 없고 `gh` CLI가 사용 가능하면 `gh`를 사용합니다.
- 둘 다 사용할 수 없으면 이슈 상태를 추측하거나 로컬 문서로 대체하지 말고, 필요한 GitHub 작업을 수행할 수 없다고 명시합니다.
- 저장소나 issue 번호가 이미 명확하면 불필요하게 다시 묻지 않습니다.

## `gh` CLI fallback

GitHub integration이 없을 때 사용할 수 있는 기본 명령입니다.

- 생성: `gh issue create --title "..." --body "..."`
- 조회: `gh issue view <번호> --comments`
- 목록: `gh issue list --state open`
- 댓글: `gh issue comment <번호> --body "..."`
- 라벨 추가·제거: `gh issue edit <번호> --add-label "..."` 또는 `--remove-label "..."`
- 종료: `gh issue close <번호> --comment "..."`

CLI를 사용할 때 저장소는 `git remote -v`에서 확인하며, 저장소 안에서 실행하면 `gh`가 보통 자동으로 인식합니다.

## 작업 규칙

- 모든 코드 변경에 이슈를 새로 만들 필요는 없습니다. 사용자가 이슈 생성/기록을 요청했거나 기존 작업이 이슈로 관리되고 있을 때 GitHub Issues를 사용합니다.
- “이슈 트래커에 게시”하라는 지시가 있으면 GitHub Issue를 생성합니다.
- “관련 티켓을 가져오라”는 지시가 있으면 해당 Issue와 댓글을 읽습니다.
- 이슈와 PR은 번호 공간을 공유하므로 `#42`가 모호하면 유형을 확인한 뒤 올바른 대상을 읽습니다.
- Pull Request를 일반 요청 접수함으로 취급하지 않습니다. 사용자가 PR 작업을 요청했거나 현재 작업이 PR 문맥일 때만 PR을 작업 surface로 사용합니다.
