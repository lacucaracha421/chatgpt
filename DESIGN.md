# Lakomics Design Language

> 상태: 현재 PC Lakomics의 최상위 시각·상호작용 원칙. 2026-09-06의 Lab 06 콘텐츠 방향과 Chrome 03b 실제 개편을 통합한 기준이다.
> 상세 구현 기준은 `docs/agents/pc-design-reference.md`를 따른다. 매체별 Works 문법은 `docs/agents/works-viewer-design.md`를 따른다.

Lakomics는 장시간 사용하는 Windows 데스크톱 개인 미디어 아카이브다. 이미지·영상과 작품이 화면의 주인공이며, 앱 chrome은 자료를 찾고 정리하고 다시 감상하기 위한 조용한 도구여야 한다.

## 1. 핵심 인상

- 깔끔하고 밀도 높은 개인 아카이브.
- dark neutral 기반의 단정한 사각형, 얇은 선, 작은 반경.
- 작품과 자산의 색이 화면 분위기를 만들고 UI는 한발 물러난다.
- 기능만 남긴 무미건조한 도구도, 오래 보면 피로한 테마 장식도 피한다.
- NieR:Automata에서 참고한 것은 절제된 구획·버튼·표식이지 게임 HUD 복제가 아니다.
- mymind/Cosmos/Raindrop에서 참고한 것은 이미지 배치와 정돈감이다.
- Criterion/A24/Delicious Library의 소장감은 매체별 Collection 표현에만 제한적으로 쓴다.

## 2. 시각적 우선순위

1. 미디어와 작품 아트워크
2. 현재 위치와 선택 상태
3. 지금 작업에 필요한 조작
4. 메타데이터와 상태
5. 관리·provider·유지보수 기능

앱 chrome, 통계, 설명 문구가 자료보다 먼저 눈에 들어오면 실패다.

## 3. PC shell

PC의 기본 shell은 **Chrome 03b B 좌측 중심 구조**다.

- 가장 왼쪽은 에셋·컬렉션·망가 같은 큰 영역을 바꾸는 좁은 area rail이다.
- 그 옆은 현재 영역에 맞는 persistent contextual index다. 에셋에서는 분류·앨범, 컬렉션에서는 라이브러리/쇼케이스·유형, 망가에서는 해당 탐색 문맥을 제공한다.
- 본문 위에는 얇은 위치/창 영역만 남기고 예전의 전체 수평 toolbar를 중복하지 않는다.
- 검색은 평소 돋보기 아이콘만 보인다. 검색을 지원하는 화면에서만 실제 입력 surface를 연다.
- 에셋의 보기 설정은 인덱스 하단에서 필요할 때만 오른쪽 non-modal panel로 연다. 단순 개폐로 갤러리 폭·스크롤·선택을 바꾸지 않는다.
- 화면별 정렬·필터·관리 기능은 그 문맥에 가장 가까운 인덱스나 임시 surface에 둔다. 빈 toolbar를 유지하기 위해 기능을 복제하지 않는다.
- 창 제어는 한 곳에만 둔다. 입력·메뉴·슬라이더가 native drag region으로 오인되지 않아야 한다.

## 4. 표면과 형태

카드보다 **명도 차이 → 1px separator → 간격 → typography** 순으로 계층을 만든다.

- media tile radius: 0–2px 정도.
- 일반 행/버튼: 3–4px 정도.
- menu/popover: 작은 반경과 얇은 경계.
- dialog: 필요할 때만 더 큰 surface와 shadow.
- shadow는 실제로 떠 있는 menu/dialog/drag preview와 의미 있는 collectible object에만 쓴다.
- 일반 grid tile, toolbar, settings row, sidebar section에 장식용 shadow를 퍼뜨리지 않는다.
- glassmorphism, 장식용 gradient, 큰 rounded card, pill 남발, 강한 glow는 사용하지 않는다.

## 5. Typography와 색

- 2026-09-06 실제 화면 확인 후 확정: 한글 UI는 SUIT, 영문·작가명은 Barlow를 사용한다. 일본어는 Yu Gothic UI/Meiryo를 유지한다.
- 날짜·시각·사이드바 개수에는 Rajdhani Medium과 폭이 일정한 숫자를 사용한다. 작가명 안의 숫자는 Barlow로 유지한다.
- 폰트 파일과 라이선스를 앱에 포함해 오프라인에서도 표시한다. Segoe UI/Malgun Gothic은 폴백으로 유지한다.
- 역할 기준은 metadata 11–12px, 기본 UI 13px, 강조 label 14px, section 16px 안팎을 출발점으로 한다.
- monospace는 경로·ID·timestamp 같은 실제 기술 값에만 제한한다.
- 사용자 폴더/앨범 이름을 uppercase로 바꾸지 않는다.
- dark neutral surface가 기본이며, accent는 선택·focus·valid drop·중요한 confirmation에만 쓴다.

## 6. 선택과 컨트롤

선택의 역할을 구분한다.

- **현재 위치 / 주요 단일 선택**: pale ivory `#DDD8CA` 계열 면과 작은 내부 사각 표식. 글자와 표식은 어두운 색.
- **복수 선택 필터**: 중성 회색 면, 반복 사각 표식 없음. 누런/올리브 selection은 사용하지 않는다.
- **자산 자체의 선택**: 좌상단 작은 사각 표식 + 이미지에만 약한 중성 회색 음영. 바깥 selection outline과 metadata 영역의 색·여백 변화로 선택을 표현하지 않는다.
- keyboard focus는 selection과 별도 상태다. focus가 이동했다고 선택으로 보이거나, 선택 때문에 focus가 사라지면 안 된다.
- 일반 icon action은 quiet하게 두고, 한 화면에 강한 primary surface를 여러 개 만들지 않는다.

아이콘은 선 기반·기하학적 형태를 우선하고 stroke, optical size, baseline을 일관되게 맞춘다. 사용자 지정 Classification icon/color는 제품 데이터이므로 전역 미학을 이유로 덮어쓰지 않는다.

## 7. Gallery와 자산 정보

PC 자산 기본 보기는 **수집일별 masonry/waterfall**이다. justified row는 대체 보기로 남긴다.

- 이미지는 원본 비율을 존중한다.
- 날짜 group heading이 수집일을 맡는다.
- 이미지 바로 아래 한 줄에 왼쪽 작가, 오른쪽 `HH:mm` 수집 시각을 둔다. 날짜를 반복하지 않는다.
- 정렬·group·시각은 같은 `collectedAt`과 같은 표시 시간대에서 계산한다.
- 긴 작가명과 누락 메타데이터를 정직하게 처리하고, 가짜 현재 시각을 채우지 않는다.
- metadata가 켜져 있을 때도 이미지 감상을 방해하는 overlay로 바꾸지 않는다.
- dense scrolling에서는 hover scale, pointer-tracked transform, 타일별 shadow를 사용하지 않는다.

## 8. Collection / Works의 물성

모든 매체를 같은 카드 효과로 만들지 않는다.

- **게임**: 접합부가 보이는 닫힌 neutral case. 앞표지가 주인공이며 플랫폼 띠·가짜 책등·가짜 뒷표지를 만들지 않는다.
- **만화**: 얇은 책의 물성, 권 순서와 cover appreciation을 강조한다. 선반은 support cue이지 가구 시뮬레이션이 아니다.
- **영화/영상**: 일반 목록은 평면 poster archive다. 게임 케이스나 책 물성을 강제하지 않는다.
- **상세**: 원본 hero/backdrop 뒤에 표지를 겹치고 하단을 넓게 fade한다. 표지에는 fade를 걸지 않는다.
- 배경이 없으면 가짜 blurred background를 만들지 않고 상단 공간을 접어 compact 정보 배치로 전환한다.

물성은 Library < Detail < Showcase 순으로 강해질 수 있지만, ordinary UI와 Asset tile에는 전염시키지 않는다.

## 9. Floating surface와 tooltip

- menu, context menu, popover, 보기 설정은 같은 얇은 경계 언어를 쓴다.
- 파괴적 확인은 dialog, 즉시 선택은 menu/popover, 짧은 설명은 tooltip처럼 역할을 나눈다.
- icon만으로 의미가 모호한 **명시적 PC shell 제어**에는 짧은 비대화형 tooltip을 허용한다. 모든 버튼에 의무적으로 붙이지 않는다.
- tooltip은 `aria-label`을 대신하지 않는다. 키보드 focus에서도 같은 설명에 접근할 수 있어야 한다.
- nested menu/popover를 부모 panel의 바깥 클릭으로 오인하지 않는다.
- Esc는 가장 안쪽 surface부터 한 단계씩 닫고 같은 입력이 뒤의 선택 해제·viewer 종료까지 연쇄되지 않게 한다.

## 10. Motion과 성능

- 일반 UI 전환은 대체로 80–160ms 범위의 opacity/background/border/짧은 위치 변화로 충분하다.
- spring, bounce, 장식용 entrance animation, 상시 animation을 피한다.
- sidebar/panel open-close는 공간 관계를 이해시키기 위한 짧은 motion만 허용한다.
- gallery scroll 중 레이아웃 재계산·shadow·transform을 매 프레임 추가하지 않는다.
- 게임 case/만화 cover의 작은 lift·depth는 수집품 감상이라는 의미가 있을 때만 제한적으로 허용한다.
- reduced motion과 keyboard path를 깨지 않는다.

## 11. 피해야 할 것

- 기존 화면을 다시 SaaS dashboard/card wall로 감싸기.
- 빈 공간을 채우기 위한 설명문, 통계 카드, 장식 panel.
- 모든 곳에 아이보리/베이지를 칠해 NieR 테마처럼 만들기.
- fake retro, scanline, 기계 HUD, 과도한 Persona식 장식.
- media 비율을 희생하는 획일적 crop.
- 한 기능을 rail/index/topbar에 중복 노출.
- prototype 수치·가상 데이터·임시 레이블을 production contract로 하드코딩.

디자인 판단이 애매하면 **alignment, hierarchy, state clarity, media visibility**를 장식보다 우선한다.
