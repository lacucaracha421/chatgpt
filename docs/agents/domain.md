# Domain Docs

Lakomics 저장소에서 도메인 문서와 현재 구현을 읽는 방법을 정의합니다.

## 작업 전에 확인할 것

- 저장소 루트의 `AGENTS.md`
- 저장소 루트의 `CONTEXT.md`
- UI 작업이라면 저장소 루트의 `DESIGN.md`
- 작업 영역과 관련된 `docs/adr/` 문서
- `AGENTS.md`가 특정 기능에 대해 별도 reference/handoff 문서를 지정하면 그 문서

파일이 아직 없다면 별도로 문제 삼지 않고 현재 코드와 존재하는 문서를 기준으로 계속 진행합니다.

## 현재 저장소 구조

```text
/
├── AGENTS.md
├── CONTEXT.md
├── DESIGN.md
├── app/
│   ├── src/          # React / TypeScript frontend
│   └── src-tauri/    # Rust / Tauri backend and migrations
├── extension/        # bundled Lakomics browser extension
└── docs/
    ├── agents/
    ├── adr/
    ├── prototypes/
    └── superpowers/  # dated plans/specs; historical unless explicitly promoted
```

## 문서와 코드의 우선순위

서로 다른 자료가 충돌할 때 모든 문서를 같은 권위로 취급하지 않습니다.

- **현재 구현 사실**(필드, 스키마, API, 지원 provider, 실제 동작)은 현재 `main`의 코드·migration·type/interface를 기준으로 확인합니다.
- **현재 제품 의도와 공통 규칙**은 `AGENTS.md`, `CONTEXT.md`, `DESIGN.md`와 현재 상태로 표시된 domain reference를 따릅니다.
- `docs/adr/`의 **Accepted** 결정은 해당 영역의 설계 제약으로 취급합니다. `Superseded` ADR은 역사 자료일 뿐 현재 결정을 되살리는 근거로 사용하지 않습니다.
- 날짜가 붙은 `docs/superpowers/plans/`와 `docs/superpowers/specs/`는 완료된 작업의 기록일 수 있습니다. `AGENTS.md`나 현재 reference가 명시적으로 지시하지 않는 한 새 구현 계획처럼 실행하지 않습니다.
- `docs/prototypes/`는 시각/상호작용 의도를 보여주는 reference이며 production 구조를 그대로 복사하는 소스가 아닙니다.

문서가 현재 코드와 충돌하면 조용히 오래된 문서를 구현하지 말고 충돌 사실을 확인합니다. 현재 구현을 설명하는 문서는 가능한 한 같은 변경에서 갱신합니다.

## 도메인 용어

이슈 제목, 리팩터링 제안, 가설, 테스트 이름에는 `CONTEXT.md`에 정의된 현재 용어를 사용합니다.

## ADR 상태

ADR은 상단의 `Status`를 확인합니다.

- `Accepted`: 현재 결정
- `Superseded`: 후속 결정으로 대체된 역사 자료
- `Proposed`: 아직 확정되지 않은 제안

ADR끼리 또는 ADR과 현재 reference가 충돌하면 더 최신의 명시적 대체 관계를 우선하고, 대체 관계가 불분명하면 임의로 선택하지 말고 충돌을 명시합니다.
