# Issue tracker: GitHub

이 저장소의 이슈와 PRD는 GitHub Issues에서 관리합니다. 모든 작업에는 `gh` CLI를 사용합니다.

## 기본 명령

- 생성: `gh issue create --title "..." --body "..."`
- 조회: `gh issue view <번호> --comments`
- 목록: `gh issue list --state open`
- 댓글: `gh issue comment <번호> --body "..."`
- 라벨 추가·제거: `gh issue edit <번호> --add-label "..."` 또는 `--remove-label "..."`
- 종료: `gh issue close <번호> --comment "..."`

저장소는 `git remote -v`에서 확인하며, 저장소 안에서 실행하면 `gh`가 자동으로 인식합니다.

## Pull requests as a triage surface

PRs as a request surface: no.

## 스킬 연동 규칙

- “이슈 트래커에 게시”하라는 지시가 있으면 GitHub 이슈를 생성합니다.
- “관련 티켓을 가져오라”는 지시가 있으면 `gh issue view <번호> --comments`를 실행합니다.
- 이슈와 PR은 번호 공간을 공유하므로 `#42`가 모호하면 PR을 먼저 조회하고 이슈를 조회합니다.
