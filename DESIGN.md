# Lakomics Design Language

Lakomics는 장시간 사용하는 고밀도 Windows 데스크톱 미디어 라이브러리다.
SaaS 대시보드, 랜딩 페이지, 모바일 앱, shadcn 데모처럼 보이면 안 된다.

## 핵심 인상

- 조용하고 밀도 높은 데스크톱 도구
- 이미지와 영상이 화면의 주인공
- 장식보다 정렬, 계층, 상태 표현을 우선
- 유행하는 UI보다 오래 써도 질리지 않는 UI
- Eagle/Lightroom/Windows 데스크톱 도구의 장점만 참고하고 그대로 복제하지 않음

## 피해야 할 것

특별한 이유 없이 다음을 추가하지 않는다.

- 장식용 gradient
- glassmorphism
- 큰 둥근 카드
- 일반 버튼의 pill 형태
- 큰 페이지 제목과 과도한 설명문
- 카드형 통계 위젯
- 비어 있는 공간을 채우기 위한 장식
- 모든 패널의 그림자
- 일반 hover의 scale/translate 애니메이션
- 모든 컨트롤에 동일한 테두리/베벨/강조색
- "기술적인 느낌"만을 위한 monospace + uppercase 제목
- 의미가 다른 화면을 억지로 완전히 같은 레이아웃 공식에 맞추는 것

## 우선순위

시각적 우선순위는 다음 순서를 따른다.

1. 미디어
2. 현재 위치와 선택 상태
3. 현재 작업에 필요한 조작
4. 메타데이터
5. 유지보수/보조 기능

앱 chrome은 미디어보다 먼저 눈에 들어오면 안 된다.

## 간격과 형태

기본 간격 단위는 4px이다.

- 4px: 미세 간격
- 6px: 조밀한 inline 간격
- 8px: 일반 컨트롤 간격
- 12px: 구역 간격
- 16px: 드물게 사용하는 큰 분리

권장 radius:

- 미디어 타일: 0~2px
- 행/버튼: 3~4px
- 메뉴/팝오버: 4~6px
- 대화상자: 최대 8px

12px 이상의 radius는 명확한 이유가 없으면 사용하지 않는다.

## 표면

카드보다 경계를 사용한다.

우선순위:
1. 배경 명도 차이
2. 1px separator
3. 간격
4. typography
5. 필요한 경우에만 shadow

shadow는 dialog, popover, context menu, drag preview처럼 실제로 떠 있는 요소에만 사용한다.

## Typography

일반 UI는 Segoe UI를 사용한다.

monospace는 ID, 경로, timestamp, 기술적 값처럼 실제 이점이 있을 때만 사용한다.
사용자가 만든 폴더/앨범 이름을 uppercase로 바꾸지 않는다.

권장 크기:
- 11px: 3차 metadata
- 12px: 보조 UI
- 13px: 기본 UI
- 14px: 강조 label
- 16px: 드문 section heading

## 색상

중성 dark gray + 하나의 절제된 accent를 기본으로 한다.

accent는 다음 상태에 사용한다.
- selection
- keyboard focus
- valid drop target
- 필요한 경우 primary confirmation

모든 active tab, 모든 icon, 모든 button에 accent를 사용하지 않는다.

## Controls

모든 컨트롤을 같은 상자로 만들지 않는다.

- Quiet: 자주 쓰는 저위험 icon/toolbar action. 평면, 기본 border 없음.
- Standard: 일반 labeled action/select. 필요할 때만 얇은 border.
- Emphasized: 한 그룹에서 가장 중요한 즉시 실행 action 하나. accent fill 허용.

한 화면에 emphasized action을 여러 개 두지 않는다.

## Toolbar

Toolbar는 application chrome이 먼저고 form row가 아니다.

- 현재 위치와 문맥상 필요한 컨트롤만 둔다.
- obvious subtitle을 붙이지 않는다.
- 선택 모드에서는 일반 탐색 도구를 선택 작업으로 교체한다.
- 자주 쓰지 않는 기능은 overflow로 보낸다.
- 공통 높이는 유지해도 내부 구성을 모든 화면에 강제로 같게 만들 필요는 없다.
- 일반 위치 제목은 monospace/uppercase로 꾸미지 않는다.

## Sidebar

Sidebar는 버튼 목록이 아니라 navigation tree처럼 보여야 한다.

- selected는 약한 배경 + 좁은 indicator
- hover는 selected보다 약하게
- icon은 label보다 시각적으로 약하게
- count는 낮은 대비
- 내부를 카드로 나누지 않음

## Gallery

Gallery chrome은 거의 사라져야 한다.

- 이미지 간격 4~6px
- 타일 radius 0~2px
- thumbnail shadow 금지
- selection은 inset outline으로 표시
- hover scale 금지
- metadata는 사용자가 켰을 때만 표시

## Inspector / Settings

Inspector는 하나의 정보 sheet로 취급하고 boxed sub-panel을 남발하지 않는다.

Settings는 desktop preference window처럼 구성한다.
큰 카드, 큰 heading, 마케팅 문구 대신 compact property row와 separator를 사용한다.

## Motion

기본 duration은 80~160ms.

일반 UI에서는 opacity/background/border 같은 상태 전환을 우선한다.
translateY, scale, spring, 장식용 entrance animation은 피한다.

### Works collectible interaction exception

Works의 만화 표지 감상 뷰어와 게임 패키지 전시는 일반 UI motion 규칙의 제한적 예외다.
실제 수집품을 집어 들거나 살펴보는 의미를 전달할 때만 작은 translate/scale/3D transform과
접지·부유 shadow를 사용할 수 있다.

- 일반 버튼, toolbar, settings row, 일반 card, Asset tile에는 이 예외를 적용하지 않는다.
- 기본 browsing 상태에서는 효과를 없애거나 매우 약하게 유지한다.
- 큰 bounce/spring, 큰 각도 회전, 강한 holo/glare, 상시 animation은 금지한다.
- 권장 motion 시간은 기존 80~160ms 범위를 우선한다.
- game package는 정면 cover밖에 없는 경우가 많으므로 옆/뒤 빈 면이 드러날 정도로 회전하지 않는다.
- Manga volume cover click의 기본 목적은 metadata dialog가 아니라 cover appreciation이다.

이 예외의 현재 시각 기준은
`docs/prototypes/lakomics-works-v6-reference.html`이며 production 구현은 기존 token/component를 사용한다.

## AI 출력 거부 체크

UI 변경을 받기 전에 다음이 새로 생겼는지 확인한다.

- 12px 이상 radius
- 장식용 gradient
- 큰 padding
- 기존 영역을 둘러싼 새 card wrapper
- obvious title을 설명하는 새 subtitle
- non-floating element의 새 shadow
- ordinary pill button
- 큰 accent surface
- hover scale/translate
- token 대신 새 raw color/spacing/radius/font-size
- 시각적 wrapping만을 위한 새 component
- "tech feel"만을 위한 monospace/uppercase

장식을 추가하는 것과 alignment/spacing/hierarchy/state clarity를 개선하는 것 중 선택해야 한다면 항상 후자를 우선한다.
