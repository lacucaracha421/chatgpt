# 태그와 컬렉션을 핵심 분류 체계로 사용한다

Status: Superseded  
Superseded by: ADR-0013 (`classification-tree-single-direct-membership`)

이 ADR은 초기 설계에서 실제 파일 폴더와 사용자 분류를 분리하고, 단일 물리 위치를 사용자 분류 모델로 사용하지 않기로 한 역사적 결정을 기록한다.

자산과 작품은 실제 파일 폴더가 아니라 여러 개를 동시에 부여할 수 있는 태그와 사용자가 선별하는 컬렉션으로 분류한다. 하나의 대상이 여러 주제와 용도에 속할 수 있으므로 단일 위치를 강제하는 계층형 폴더는 첫 버전의 핵심 분류 체계에서 제외하고, 저장소의 실제 폴더 배치는 사용자 분류와 분리한다.

현재 Lakomics는 **실제 저장 경로와 사용자 분류를 분리한다는 원칙은 유지**하지만, Asset Library의 주 탐색은 계층형 Classification tree를 사용한다. 현재 분류 membership 규칙은 ADR-0013과 `CONTEXT.md`를 따른다.
