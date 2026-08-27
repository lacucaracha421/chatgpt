# 분류 트리를 주 탐색 수단으로 사용한다

Status: Accepted  
Clarified by: ADR-0013 (`classification-tree-single-direct-membership`)

데스크톱 앱의 왼쪽 사이드바에 계층형 분류 트리를 두고 이를 Asset Library에서 자산과 분류 항목을 찾는 기본 경로로 사용한다. 상위 분류를 선택하면 기본적으로 모든 하위 분류의 자산을 포함하되, `하위 분류의 자산 포함`을 끄거나 direct-only 조회를 사용하면 직접 연결된 자산만 표시한다. 검색은 항목 위치를 모를 때 사용하는 보조 탐색 수단이다.

여기서 분류 트리의 `work` 항목은 Classification Entry의 종류를 뜻하며, 별도의 Collection/Works 브라우징 모델을 분류 트리에 합치라는 의미가 아니다. Collection/Works의 타입별 탐색과 표현 규칙은 현재 `CONTEXT.md`와 Works reference를 따른다.
