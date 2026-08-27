# 분류 트리는 계층형 탐색이며 자산의 직접 분류는 하나만 가진다

Status: Accepted  
Date: 2026-08-27  
Supersedes: ADR-0004, ADR-0005  
Clarifies: ADR-0012

## 결정

Asset Library의 Classification은 **계층형 탐색/분류 트리**다.

- `ClassificationEntry`는 부모를 최대 하나만 가진다.
- 한 Asset의 **직접 Classification membership은 최대 하나**다.
- 하위 항목에 직접 속한 Asset이 상위 항목에서도 보이는 것은 별도 직접 membership을 복제해서 저장하는 것이 아니라 계층 조회로 계산한다.
- direct-only 조회에서는 선택한 Classification에 직접 연결된 Asset만 표시한다.
- Classification 이름이나 트리 위치는 파일의 실제 Media Vault 저장 경로를 결정하지 않는다.
- 사용자 정의 Classification 이름을 앱 기능 분기의 식별자로 사용하지 않는다. 이 원칙은 ADR-0006을 따른다.

## 별도의 다중 묶음

하나의 Asset을 사용자가 여러 묶음에 동시에 넣고 싶을 때 Classification membership을 다중화하지 않는다.

`Album`은 Classification과 별개인 사용자 선별 축이며, 한 Asset이 여러 Album에 속할 수 있다. Album 자체는 계층 구조를 가질 수 있지만 Asset 레코드나 파일을 복제하지 않는다.

Collection/Works 역시 Classification의 다른 이름이 아니다. Collection은 게임·만화·영화 작품 메타데이터와 표현을 관리하는 별도 모델이며 기존 Asset을 참조할 수 있다.

## 이유

직접 Classification을 하나로 제한하면 다음이 단순하고 예측 가능해진다.

- 드래그/이동과 현재 위치의 의미
- 미분류 상태 판단
- 브라우저 확장 수집 대상 결정
- 상위/하위 분류 포함 조회
- 사이드바 트리에서 Asset의 기본 위치

동시에 Album과 Collection을 별도 관계로 유지하면 한 Asset을 여러 감상 맥락에 재사용하는 유연성도 잃지 않는다.

## 역사적 결정과의 관계

ADR-0004의 **실제 파일 저장 경로와 사용자 분류를 분리한다**는 취지는 유지한다. 다만 현재 UI는 계층형 Classification tree를 핵심 탐색 수단으로 사용하므로 “계층형 폴더를 핵심에서 제외”한다는 부분은 더 이상 현재 결정이 아니다.

ADR-0005의 **typed hierarchy와 조상 포함 조회** 취지는 유지한다. 다만 “한 Asset에 서로 다른 가지의 Classification을 여러 개 직접 지정”한다는 부분은 현재 모델에서 사용하지 않는다.

ADR-0012의 분류 트리 주 탐색 원칙은 유지하며, 이 ADR이 직접 membership과 Album/Collection 경계를 명확히 한다.
