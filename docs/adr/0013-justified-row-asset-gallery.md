# 자산 목록은 높이가 같은 행으로 배치한다

**Status:** Superseded by ADR-0034

이 문서는 초기 PC Asset 기본 배치 결정의 역사 기록이다. 현재 PC 기본은 수집일별 masonry이며 justified rows는 선택 가능한 대체 보기로 남는다. 현재 규칙은 `0034-current-pc-archive-shell-and-browsing-defaults.md`와 `../agents/pc-design-reference.md`를 따른다.

자산 목록은 이미지 원본 비율을 유지하면서 한 행의 높이를 맞추고 각 이미지의 폭을 조절하는 행 기반 배치를 사용한다. 세로 열을 퍼즐처럼 채우는 배치보다 정렬 순서가 명확하고, 이미지 추가·삭제와 창 크기 변경 때 위치 계산이 예측 가능하며, 화면에 보이는 행만 그리는 최적화를 단순하게 적용할 수 있기 때문이다.
