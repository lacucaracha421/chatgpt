# 종류가 있는 계층형 분류 항목을 사용한다

Status: Superseded  
Superseded by: ADR-0013 (`classification-tree-single-direct-membership`)

이 ADR은 현재 Classification tree의 전신이 된 typed hierarchy와 조상 포함 조회 아이디어를 기록한다.

분류 트리에는 상위 분류, 작품, 캐릭터, 버전처럼 의미가 구분된 항목이 부모·자식 관계로 나타나며 각 항목은 부모를 최대 하나만 가진다. 작품은 같은 이름의 태그를 복제하지 않고 트리에 직접 참여한다. `수영복 시로코` 같은 하위 항목을 자산에 지정하면 `시로코`, `블루 아카이브`, `게임`에도 자동으로 속한 것으로 처리한다. 하나의 자산에는 서로 다른 가지의 분류 항목을 여러 개 지정할 수 있다.

현재 Lakomics는 **typed hierarchical tree와 조상 포함 조회의 취지는 유지**하지만, 한 Asset의 직접 Classification membership은 최대 하나다. 여러 사용자가 선별한 묶음은 Album 등 별도 관계를 사용한다. 현재 규칙은 ADR-0013과 `CONTEXT.md`를 따른다.
