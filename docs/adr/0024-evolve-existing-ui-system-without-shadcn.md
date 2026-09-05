# 기존 공통 UI를 발전시키고 shadcn을 도입하지 않는다

> Status: Accepted for the custom shared-UI/CSS decision. Implementation clarification (2026-09-05): the current app uses `@heroicons/react`, not the original `lucide-react` detail below. Preserve the original rationale; use current package imports for icon work.

Eagle을 참고한 데스크톱 UI 개편은 현재 React 공통 UI와 일반 CSS 디자인 토큰을 발전시키는 방식으로 진행하고 shadcn과 Tailwind는 도입하지 않는다. shadcn은 완성된 제품 디자인이 아니라 UI 부품의 출발점이므로, 기존 버튼·메뉴·대화상자를 교체하고 새 스타일 체계를 운영하는 비용보다 현재 공통 Interface의 시각·키보드·포커스 동작을 함께 개선하는 편이 Lakomics의 일관성과 모듈 경계를 더 잘 지킨다. 아이콘은 기존 `lucide-react`로 통일한다.
