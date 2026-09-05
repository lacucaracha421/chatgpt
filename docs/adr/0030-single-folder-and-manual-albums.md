# 일반 폴더는 단일 직접 소속, 앨범은 다중 수동 묶음으로 사용한다

> Status: Accepted for single direct classification and manual Albums; clarified by [the membership decision](0013-classification-tree-single-direct-membership.md) and [ADR-0031](0031-collection-as-typed-work-model.md). The original future-Collection paragraph below records rollout intent, not a current TODO.

ADR 0004와 ADR 0029 중 자산의 다중 분류 폴더 소속 및 폴더 드롭의 추가 동작을 대체한다.

일반 폴더 드롭은 이동이며 자산의 직접 연결은 최대 하나다. 하위 폴더 자산이 상위 폴더에서도 보이는 것은 재귀 조회 결과이며 상위 연결을 중복 저장하지 않는다. 여러 수동 묶음이 필요한 경우 별도 앨범을 사용한다.

앨범은 사용자가 만들고 직접 자산을 담는 계층형 목록이다. 한 자산은 여러 앨범에 속할 수 있지만 자동 조건이나 일반 폴더 연동은 없다. 일반 폴더와 앨범은 모두 SQLite 참조만 바꾸며 미디어 금고의 파일을 복사하거나 이동하지 않는다.

향후 컬렉션은 게임·만화·작품의 표지, 설명, 대표 이미지와 전시 배치를 갖는 별도 모델로 만든다.
