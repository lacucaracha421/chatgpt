## Agent skills

### Issue tracker

이 저장소의 이슈는 GitHub Issues에서 관리합니다. 자세한 내용은 `docs/agents/issue-tracker.md`를 참고하세요.

### Domain docs

이 저장소는 단일 컨텍스트 도메인 문서 구조를 사용합니다. 자세한 내용은 `docs/agents/domain.md`를 참고하세요.

### Implementation guidelines

하드코딩, 공통 UI, Module 설계 규칙은 `docs/agents/implementation.md`를 따르세요.

### Visual design

UI를 만들거나 수정할 때는 루트의 `DESIGN.md`를 먼저 읽고 따르세요.
기능 일관성뿐 아니라 정보 밀도, 표면 계층, 타이포그래피와 "AI 생성물처럼 보이는" 장식 패턴도 검토합니다.

### Works / Collection v2

Works/Collection 기능을 수정하기 전에는
`docs/agents/lakomics-works-handoff-v2.md`를 읽으세요.
시각/상호작용 기준은
`docs/prototypes/lakomics-works-v6-reference.html`을 함께 참고하세요.
프로토타입 코드를 그대로 복사하지 말고 기존 React 구조, 공통 UI, 디자인 토큰에 맞게
시각적 의도와 상호작용만 구현합니다.
Works/Collection에 한해 handoff v2의 최신 결정은 `CONTEXT.md`의 구형 Showcase /
단일 provider 설명보다 우선합니다.
