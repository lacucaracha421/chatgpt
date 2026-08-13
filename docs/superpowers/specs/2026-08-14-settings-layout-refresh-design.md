# Settings Layout Refresh Design

Lakomics 설정을 상단 탭과 느슨한 내용 묶음에서 고밀도 Windows 데스크톱 환경설정 화면으로 바꾼다.

## Layout

- `ViewToolbar` 아래를 좌우 2열로 나눈다.
- 왼쪽은 폭이 고정된 세로 탐색 목록이다. 현재 섹션은 약한 배경과 2px indicator로만 표시한다.
- 오른쪽은 독립 스크롤 영역이며, 최대 폭을 제한한 속성 시트를 표시한다.
- 각 섹션에는 16px 이하의 제목과 짧은 보조문을 한 번만 둔다.

## Content hierarchy

- 일반, 브라우저 확장, 메타데이터 가져오기는 label/value/action 3열 속성 행을 사용한다.
- 긴 경로와 주소는 monospace 값으로 표시하고 말줄임 없이 줄바꿈한다.
- 백업은 카드 대신 구분선이 있는 표 형태의 행으로 표시한다.
- 단축키와 버튼 설명은 기존 표를 유지하되 헤더와 섹션 간격을 조밀하게 한다.
- 한 섹션에서 강조 버튼은 즉시 실행하는 핵심 작업 하나만 사용한다.

## Constraints

- 기능, 저장 형식, 비동기 흐름은 바꾸지 않는다.
- 새 컴포넌트, 아이콘, 의존성, gradient, shadow, 큰 radius를 추가하지 않는다.
- 기존 디자인 토큰과 공통 `Button`, `Toast`, `Skeleton`만 사용한다.
- 키보드 접근성과 `aria-current` 탐색 의미를 보존한다.
