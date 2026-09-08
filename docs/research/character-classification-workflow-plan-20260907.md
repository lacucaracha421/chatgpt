# Lakomics 반자동 캐릭터 분류 제품/UX 계획

상태: **2026-09-08 Batch 1–4 구현 및 격리 자동 검증 완료; 실제 WebView·운영 acceptance 미실행**
날짜: 2026-09-07

이 문서는 이미 검증한 CCIP 기반 캐릭터 검색 실험을 실제 PC Lakomics의 분류 흐름에 연결하기 위한 제품 구조와 UX 방향을 정리한다.

중요: 이 문서의 사용자 목표와 UX 원칙은 우선순위가 높지만, 세부 DB/API/컴포넌트 설계는 현재 실제 저장소를 먼저 검토한 뒤 결정한다. 기존 기능을 깨뜨리거나 필요 이상으로 서버/모바일/Cloud까지 확장하지 않는다.

## 2026-09-08 확정 결정

- 캐릭터는 기존 classification 다중 소속이 아닌 **별도 character relation**으로 저장한다. 기존 폴더와 단일 직접 소속 정책(ADR-0013/0030)은 유지한다.
- series scope는 명시적으로 선택한 classification ID의 **recursive subtree**다. kind/depth/이름으로 시리즈를 추론하지 않는다.
- same-crop 2-of-5, 공개 threshold, detector score/NMS, 18% margin을 동결한다. query와 reference 모두 crop을 사용하며 유효 crop이 없을 때만 whole fallback한다. whole OR branch는 사용하지 않는다.
- Registry/migration보다 **Batch 1 제품 런타임 재현성 검증을 먼저** 수행한다. 이 선행 gate를 통과한 뒤 Registry, native 스캔, 검토 UI까지 구현했다. Linux 배포·active DB migration은 포함하지 않는다.
- 기존 classification mapping은 선택적 대응 정보다. 승인 결과를 기존 캐릭터 폴더에 자동 추가하지 않는다. 초기 캐릭터 소속은 Character Lab에서 조회한다.

Batch 1 구현·검증 계약: [app/character-runtime/README.md](../../app/character-runtime/README.md).
실행 근거와 미검증 범위: [Batch 1 검증 기록](character-runtime-batch1-20260908.md).

Registry·refs·human decision 및 v44 migration/복구 근거:
[Batch 2 검증 기록](character-registry-batch2-20260908.md). 운영 DB migration과 native IPC 검증은 아직 수행하지 않았다.

실제 Rust→Python 스캔, incremental cache 및 취소/오류 격리 근거:
[Batch 3 검증 기록](character-scan-batch3-20260908.md).

검토 UI, 다중 캐릭터 원자적 승인, 실제 파일 재검증 및 최종 검증 범위:
[Batch 4/5 검증 기록](character-review-batch4-20260908.md). WebView IPC·운영 적용은 아직 수행하지 않았다.

## 1. 문제 배경

현재 Lakomics의 classification 트리는 실제 사용 과정에서 다음과 같이 섞여 있다.

```text
리버스
├─ 가방팟
├─ 전쟁
├─ 파리
├─ 아르코스팟
├─ 마커스
├─ 중국
├─ 런던
├─ 버전 표지
└─ ...
```

즉 하나의 시리즈 아래에 캐릭터, 지역, 이벤트, 테마, 임시 그룹 등이 동일한 classification 계층으로 존재한다. 어떤 시리즈는 캐릭터 classification이 거의 없고 시리즈 단위로만 수집돼 있다.

사용자는 브라우저 확장프로그램으로 저장할 때 이미 어느 정도 시리즈/작품 단위 classification을 직접 선택한다. 따라서 캐릭터 인식은 8,000장 전체에서 전역 검색하는 문제가 아니라, **사용자가 이미 지정한 시리즈 내부에서 캐릭터를 2차 분류하는 문제**로 좁힐 수 있다.

예:

```text
확장프로그램 저장
  -> 사용자가 "리버스" 지정
  -> PC Lakomics에 리버스 asset로 들어옴
  -> 리버스에 등록된 캐릭터 refs만 비교
  -> 마커스 / 카카니아 / 미확정 / 충돌 후보
```

이 series scope는 단순 최적화가 아니라 오탐률을 낮추는 중요한 product constraint로 취급한다.

## 2. 목표

목표는 100% 무인 자동 태깅이 아니다.

**사용자가 이미 해 둔 1차 시리즈 분류 위에 캐릭터 추천을 얹고, 수십~수백 장을 하나씩 직접 찾는 일을 크게 줄이는 반자동 분류**가 목표다.

우선순위는 다음과 같다.

1. 잘못된 캐릭터 classification을 자동 확정하는 위험을 낮춘다.
2. 높은 신뢰도의 후보를 한 번에 검토/승인할 수 있게 한다.
3. 미탐은 미분류 상태로 남겨도 된다.
4. 기존 classification 트리와 사용 습관을 최대한 보존한다.
5. 여러 캐릭터가 같은 이미지에 등장하는 경우 복수 character relation을 허용한다.

## 3. 핵심 제품 원칙

### 3.1 기존 폴더를 전부 캐릭터 폴더로 해석하지 않는다

기존 시리즈 하위 classification에는 캐릭터가 아닌 항목이 많다. 따라서 "시리즈의 모든 자식 = 캐릭터" 같은 추론을 금지한다.

대신 별도의 **Character Registry**를 둔다.

Character Registry의 각 캐릭터는 다음을 가진다.

- 어떤 series classification에 속하는지
- 선택적으로 어떤 기존 classification에 대응하는지 (membership 적용 대상 아님)
- 표시 이름
- reference image 5장
- recognition 준비 상태
- 선택적으로 negative feedback / 제외 예시

기존에 `마커스` classification이 있으면 registry가 그 classification ID를 선택적으로 연결할 수 있다. 캐릭터 생성은 기존 폴더 생성이나 자산 이동을 수반하지 않는다.

### 3.2 캐릭터는 일반 classification과 의미적으로 분리한다

캐릭터를 독립 entity/table로 두고 asset과의 다중 character relation을 별도로 관리한다. 기존 classification에 캐릭터 종류를 추가하거나 다중 직접 소속을 도입하지 않는다.

제품 관점에서 필요한 것은 **시리즈에 등록한 recognition target과 asset의 명시적 캐릭터 관계**다. 단순 폴더명이나 depth로 추측해서는 안 된다.

### 3.3 검토 상태는 실제 폴더로 만들지 않는다

다음 항목은 영구 classification 폴더가 아니라 **Smart View / query state**여야 한다.

- 추천 분류
- 미분류 / 미확정
- 충돌
- 검토 완료
- 거절/negative feedback 이력

예를 들어 `리버스/미분류`라는 실제 폴더를 만들고 asset을 이동시키는 구조는 피한다. 분류가 끝나면 query 결과에서 자연스럽게 사라지는 상태여야 한다.

### 3.4 원본 asset의 물리 이동은 하지 않는다

캐릭터 분류는 기존 Lakomics asset에 character relation을 추가하는 작업이다. 같은 이미지에 마커스와 카카니아가 함께 있으면 Character Lab의 두 캐릭터 조회에서 모두 보일 수 있어야 한다. 기존 classification membership과 물리 파일은 유지한다.

### 3.5 기본 동작은 추천 + 승인

초기 제품에서는 recognition 결과를 즉시 최종 classification으로 확정하지 않는다.

```text
고신뢰 후보
  -> 추천 목록
  -> 사용자가 개별 또는 일괄 승인
  -> 별도 character relation과 human decision을 원자적으로 저장

미통과/애매함
  -> 미확정 또는 충돌 view
```

## 4. 현재 검증된 recognition baseline

실험 결과의 상세 근거는 다음 문서를 기준으로 한다.

- `TEST_kisaki/_experiment/CHARACTER-CROP-CONSENSUS-VALIDATION-20260907.md`
- `TEST_kisaki/_experiment/CROP-README.md`
- `TEST_kisaki/_experiment/verify_fixed.py`

현재 1순위 baseline은 다음과 같다.

```text
series 내부 asset
  -> YOLOX-s anime character detector
  -> 각 character box + 18% margin crop
  -> crop별 ccip-caformer_b36-24 embedding
  -> 캐릭터 refs 5장과 비교
  -> 동일 query crop이 서로 다른 refs 2장 이상에서
     CCIP distance <= 0.21323118981474148
  -> 해당 캐릭터 추천 후보
```

정확한 기준: reference도 detector/crop을 적용한다. query crop별로 각 reference 이미지 안의 crop 최소 거리를 구한 뒤, 서로 다른 reference 5개의 거리 중 두 번째 최솟값을 취한다. query crop들 중 그 값의 최솟값이 threshold 이하면 추천이다. 유효 crop이 없는 경우에만 해당 이미지 전체를 하나의 crop으로 대체한다. 확장 후 한 변이 24px 미만인 crop은 제외한다. EXIF·흰색 alpha 합성·첫 프레임·detector BGR bicubic letterbox·CCIP bilinear 384 전처리를 함께 동결한다.

고정 파라미터:

- CCIP: `deepghs/ccip_onnx / ccip-caformer_b36-24`
- detector: `ksasao/anime-character-detector` YOLOX-s ONNX
- detector score: `0.30`
- NMS: `0.45`
- crop margin: `18%`
- max boxes: `8`
- refs: 기본 5장
- CCIP threshold: `0.21323118981474148`

`whole-image OR consensus2`는 현재 제품 baseline으로 사용하지 않는다. Hina와 `test_3` 독립 검증에서 whole-image branch가 이미 제거한 오탐을 다시 통과시키는 문제가 있었다.

독립 검증의 참고 결과:

- Hina: consensus2 target 18/19, FP 4, FN 1
- `test_3`: 최초 FP 1장은 사용자가 실제 같은 캐릭터라고 확인했다. 라벨 수정 후 consensus2 target 11/13, FP 0, FN 2

이 숫자는 작은 사용자 선택 데이터셋 결과이며 전체 Lakomics 정확도라고 주장하지 않는다. 제품 통합 후에는 **실제 series-scoped 라이브러리**에서 별도 검증한다.

## 5. series scope 규칙

사용자가 확장프로그램이나 기존 Lakomics 분류로 이미 지정한 series classification과 모든 후손을 hard scope로 사용한다. `directOnly`나 현재 화면 필터·로드된 페이지 수를 분석 범위에 암묵적으로 적용하지 않는다. 정상 상태의 지원 미디어만 분석하며 영상은 제외한다. GIF 첫 프레임은 실험 런타임과의 호환 동작이며 제품 scan 대상 채택은 별도로 명시한다.

2026-09-08 read-only DB 확인: 리버스 직접 소속 1,586개와 recursive subtree 2,606개는 서로 다르다. 후자는 이미지 2,561개, GIF 2개, 영상 43개였다. 고정 운영 수치가 아니며 scan 시 다시 계산한다.

예:

```text
마커스 분석
  -> 전체 8,000장 검색 X
  -> 리버스 classification에 속한 asset만 후보

키사키 분석
  -> 전체 라이브러리 검색 X
  -> 블루아카이브 series scope만 후보
```

recognition engine이 시리즈 자체를 추측하거나 자동 수정하는 기능은 이번 범위에 넣지 않는다.

만약 asset이 잘못된 series에 들어갔다면 캐릭터가 전혀 맞지 않아 `미확정`으로 남을 수 있다. 검토 UI에서 `시리즈 변경`으로 기존 classification을 수정할 수 있는 가벼운 escape hatch를 검토한다.

## 6. 제안 UX: Character Classification / Character Lab

초기 버전에서 왼쪽 classification 트리를 대규모 재구축하지 않는다. 시리즈를 선택한 상태에서 열 수 있는 **별도 캐릭터 분류 화면**을 우선한다.

진입 방식은 현재 UX를 검토한 뒤 다음 중 가장 자연스러운 것을 선택한다.

- series context action: `캐릭터 분류`
- AssetBrowser toolbar action
- 시리즈 화면 내부의 secondary action

### 6.1 Character Registry 화면

예시:

```text
리버스 / 캐릭터 분류

캐릭터                 refs        상태        분류
마커스                  5 / 5       준비됨      마커스
카카니아                5 / 5       준비됨      카카니아
라모나                  2 / 5       설정 필요   라모나
소네트                  0 / 5       설정 필요   소네트

[+ 캐릭터 추가]                     [리버스 분석]
```

`refs 5/5`는 recognition 준비 상태다. 5장을 채우기 전에는 기본 자동 분석 대상에서 제외하거나 명확한 미준비 상태로 표시한다.

### 6.2 reference 등록

파일 선택 대화상자로 별도 이미지 파일을 관리하게 하기보다 **이미 Lakomics에 들어 있는 asset을 reference로 지정하는 UX**를 우선한다.

권장 동작:

```text
AssetBrowser에서 이미지 여러 장 선택
  -> "캐릭터 기준 이미지로 등록"
  -> 캐릭터 선택
```

또는 Character Registry에서 ref 슬롯을 눌러 현재 series asset을 고르는 picker를 제공할 수 있다.

ref 이미지는 원본 복사본을 새로 만들 필요 없이 stable asset ID를 참조하는 방향을 우선 검토한다. asset이 trash/delete 될 때 ref 무결성을 어떻게 처리할지는 반드시 정의한다.

reference 선택 가이드 UI는 과도하게 강제하지 않는다. 다만 다음 정도는 설명할 수 있다.

- 캐릭터가 비교적 크게 보이는 이미지
- 서로 다른 포즈/의상/구도를 섞는 편이 유리
- 완전 동일/중복 이미지 5장을 refs로 채우지 않기

### 6.3 분석 실행

series에 준비된 캐릭터가 있을 때:

```text
[리버스 캐릭터 분석]

분석 대상 2,561장 (recursive subtree의 정상 이미지, 예시)
준비된 캐릭터 8명
캐시된 asset 1,500
새로 분석할 asset 1,061
```

가능하면 모든 실행마다 전체 모델 추론을 다시 하지 않는다. asset/model/config identity를 이용해 detector/embedding 결과를 캐시하고 새 asset만 증분 처리한다.

## 7. 분석 결과 상태

최소한 다음 상태를 구분한다.

### 추천

특정 캐릭터가 `same-crop 2-of-5 consensus`를 통과한 asset.

예:

```text
마커스 추천 47
카카니아 추천 31
소네트 추천 22
```

### 미확정

series에는 속하지만 준비된 어떤 캐릭터도 현재 기준을 통과하지 않은 asset.

이 상태는 실패가 아니다. 아직 registry에 없는 캐릭터, 극단적인 포즈/스타일, 시리즈 오분류, 비캐릭터 이미지 등이 모두 들어갈 수 있다.

### 충돌

한 asset이 서로 다른 캐릭터 후보를 동시에 통과한 경우.

충돌을 억지로 top-1로 자동 해결하지 않는다. 다인 이미지일 수 있으므로 복수 캐릭터가 모두 정답일 수 있다.

### 승인됨

사용자가 추천을 승인하여 별도 character relation이 적용된 상태. 이후 같은 모델/refs 상태에서 반복 추천하지 않도록 해야 한다. refs 변경은 예측을 오래된 상태로 만들지만 human decision이나 승인된 관계를 자동 취소하지 않는다.

### 거절됨 / negative feedback

사용자가 `이 캐릭터 아님`을 누른 결과. 초기 MVP에서는 기록만 하고 recognition score에 자동 반영하지 않아도 된다. negative feedback를 실제 scoring에 쓰려면 기존 실험처럼 별도 검증 후 도입한다.

분석 상태(`미실행/실행 중/완료/실패/오래됨`)와 human decision은 별도 축이다. 후보 0개도 분석 완료 기록이 있어야 미확정으로 조회할 수 있다. 여러 캐릭터 통과는 다중 후보이며 서로 다른 crop의 정상 다인 결과일 수 있으므로 crop 근거를 보존한다. 기존 `assets.status='review'`와 폴더 `unclassifiedOnly`를 캐릭터 상태에 재사용하지 않는다.

## 8. 검토 UI

현재 AssetBrowser의 masonry/date grouping 디자인과 selection 패턴을 최대한 재사용한다. Character Lab만 별개의 시각 언어로 만들지 않는다.

상단 상태 예시:

```text
리버스 / 캐릭터 검토

[추천 94] [미확정 83] [충돌 7]
[캐릭터: 마커스 v] [신뢰도/상태 필터]
```

추천 카드에서는 이미지 자체를 가리지 않는 선에서 다음 정보를 제공한다.

```text
마커스
3 / 5 refs
consensus distance 0.143
```

정확한 raw distance를 항상 크게 노출할 필요는 없지만, 디버그/고급 보기에서는 확인 가능해야 한다.

핵심 액션:

- `승인`
- `다른 캐릭터`
- `이 캐릭터 아님`
- 필요 시 `시리즈 변경`

다중 선택 상태에서는 다음이 중요하다.

```text
43장 선택됨
[43장 마커스로 승인]
[제안 거절]
```

사용자가 40장의 명백한 정답을 한 번에 승인하고 애매한 몇 장만 따로 보는 것이 이 기능의 핵심 가치다.

### 8.1 충돌 UX

예:

```text
[이미지]

마커스      2/5
카카니아    3/5

[마커스] [카카니아] [둘 다] [둘 다 아님]
```

`둘 다`는 반드시 고려한다. character detector가 서로 다른 crop에서 각각 다른 캐릭터를 찾는 것이 정상적인 다인 이미지 동작이기 때문이다.

## 9. 왼쪽 classification tree 방향

초기 MVP에서 현재 트리를 강제로 다음과 같이 migration하지 않는다.

```text
리버스
├─ 캐릭터
├─ 기타 분류
└─ 검토
```

장기적으로는 이런 의미적 grouping이 보기 좋을 수 있지만, 기존 `가방팟`, `전쟁`, `런던`, `마커스` 등의 구조와 사용자의 수동 분류를 대규모 이동시키는 것은 별도 UX migration 문제다.

초기에는 기존 트리를 그대로 두고 Character Registry가 `마커스 -> 기존 마커스 classification ID`처럼 mapping하는 것을 우선한다.

`추천`, `미확정`, `충돌`은 트리에 보이더라도 **virtual/smart node**로 표현해야 하며 실제 classification row를 만들 필요는 없다.

Codex는 현재 `ClassificationSidebar.tsx`, tree builder, AssetBrowser query 구조를 검토해 smart node를 넣는 것이 자연스러운지, 아니면 Character Lab 내부 탭으로만 두는 것이 더 안전한지 판단한다.

## 10. persistence / DB 방향

### 10.1 선호 방향

Character Registry, refs, review state, 승인/거절 이력처럼 사용자가 잃으면 곤란한 상태는 가능하면 `library.sqlite`의 additive schema로 보존하는 방향을 우선 검토한다.

이유:

- 현재 PC recovery point는 `library.sqlite`의 DB-backed state를 서버 snapshot으로 보존한다.
- 별도 sidecar DB를 만들면 PC migration/recovery에서 별도 복구 규칙이 생긴다.
- 기존 backup/migration framework와 함께 보호되는 편이 장기적으로 단순하다.

다만 실제 migration을 적용하기 전에 현재 schema version, backup hook, dev watcher 동작을 반드시 확인한다. active library migration은 기존 repository safety policy를 따라 verified pre-migration backup과 사용자 승인 경계를 보존한다.

### 10.2 권장 conceptual entities

정확한 SQL은 Codex 검토 후 결정한다. 필요한 개념은 대략 다음과 같다.

```text
character_target
  id
  series_classification_id
  linked_classification_id (optional; descriptive mapping only)
  display_name
  enabled
  refs revision

character_reference
  character_target_id
  asset_id
  order/index

character_prediction (recomputable; separate from human decisions)
  asset_id
  character_target_id
  score/consensus evidence
  status
  evaluated_at
  model/config version

character_decision / relation
  asset_id
  character_target_id
  accepted/rejected decision history
  refs/analysis fingerprint at decision time
```

거절 이력으로 negative feedback를 표현한다. 같은 거절을 중복 저장하는 별도 테이블은 MVP에 필요하지 않다. 추후 독립 검증에서 별도 negative example 역할이 필요해질 때만 다음 개념을 검토한다:

```text
character_negative_example
  character_target_id
  asset_id
  source = user_reject
```

`prediction`을 영구 보존할지 재생성 가능한 cache로 둘지는 데이터 크기와 UX 요구에 따라 결정한다. 사용자 승인/거절 같은 human decision은 prediction cache와 분리해 durable하게 보존해야 한다.

## 11. feature / detector cache

8,000장 이상에서 반복 실행할 수 있으므로 모델 추론 결과를 매번 새로 계산하지 않는다.

최소한 다음 identity를 고려한다.

- asset content SHA-256 또는 stable immutable content identity
- CCIP model revision/hash
- detector model revision/hash
- detector threshold/NMS
- crop margin/max boxes
- preprocessing version

캐시 가능한 것:

1. detector bounding boxes
2. whole-image CCIP embedding (유효 crop이 없을 때 fallback)
3. crop별 CCIP embedding

참조 캐릭터를 추가하거나 refs 구성이 바뀌어도 asset embedding 자체는 재사용할 수 있어야 한다. refs 변경은 distance/consensus 계산만 다시 하는 쪽이 바람직하다.

새 asset이 series에 추가되면 해당 새 asset만 inference하고 기존 캐시는 재사용하는 **incremental scan**을 목표로 한다.

## 12. 실행/성능 UX

초기 series 전체 scan은 CPU에서 시간이 걸릴 수 있다. UI thread를 막지 않고 background/native worker 경계를 사용한다.

필요한 상태:

```text
분석 중 432 / 2,561
새 embedding 86
캐시 재사용 346
취소
```

중단 후 다시 시작했을 때 완료한 inference를 버리지 않는 것이 좋다.

단, 복잡한 job scheduler를 첫 MVP부터 새로 만들지 않는다. 현재 Tauri/background 작업 패턴 중 가장 단순하고 안전한 것을 재사용한다.

분석 실패 한 장이 전체 series scan을 실패시키지 않도록 per-asset failure isolation을 둔다. 실패 asset은 별도 상태로 확인 가능해야 한다.

## 13. 승인 시 실제 library mutation

추천 승인 시 새로운 독자적인 파일 이동 로직을 만들지 않는다.

승인은 기존 classification mutation API를 호출하지 않는다. 별도 character relation과 human decision을 같은 transaction에 저장한다:

```text
사용자 승인
  -> asset_id 목록
  -> character relation + human decision 저장
  -> Character Lab count/query 갱신
```

으로 처리한다.

동일 캐릭터 승인은 idempotent해야 한다. 복수 캐릭터 승인은 독립된 character relation으로 처리하며 기존 classification과 원본은 유지한다. 승인 시 현재 series scope·asset 상태·target/refs revision을 재검사한다.

## 14. 이번 범위에서 하지 않을 것

초기 통합에서 다음은 하지 않는다.

- 서버/VPS에서 CCIP 추론 실행
- Android/Mobile에서 캐릭터 분류 편집
- 확장프로그램에서 캐릭터까지 직접 선택하도록 강제
- 시리즈 자체를 AI로 자동 추측
- 기존 전체 classification tree의 대규모 재배치/migration
- 추천 결과의 무조건 자동 확정
- 새로운 Cloud backfill 또는 R2 전체 재업로드
- 외부 API/VLM을 이용한 캐릭터 이름 자동 생성

이 기능은 우선 **PC Lakomics 내부의 series-scoped 반자동 캐릭터 분류 도구**로 한정한다.

## 15. Linux 전환 직전 운영 제약

현재 PC는 Linux 설치를 앞두고 있다. 따라서 구현 과정에서 불필요한 운영 범위 확대를 피한다.

- 코드 변경은 작은 검증 batch로 나눈다. commit/push는 해당 Git 동작에 대한 별도 명시적 승인이 있을 때만 수행한다.
- active `library.sqlite` schema migration이 필요하면 기존 backup/migration policy를 따른다.
- managed media 자체를 대량 이동/재작성하지 않는다.
- Cloud/VPS/Android 배포 변경은 이번 기능에 필요하지 않다면 하지 않는다.
- 작업 완료 후 Cloud replication 상태를 확인하고 PC recovery point를 새로 만드는 흐름을 유지한다.

## 16. 권장 구현 단계

### Batch 0 — Codex read-only 검토 (2026-09-08 완료)

먼저 실제 코드와 schema를 읽고 이 문서의 가정이 맞는지 확인한다.

최소 검토 대상:

- `app/src/classification/ClassificationSidebar.tsx`
- `app/src/classification/buildTree.ts`
- `app/src/assets/AssetBrowser.tsx`
- `app/src/library/types.ts`
- `app/src/library/client.ts`
- `app/src-tauri/src/library/classification.rs`
- `app/src-tauri/src/library/query.rs`
- `app/src-tauri/src/library/db.rs`
- `app/src-tauri/src/library/backup.rs`
- 기존 migrations
- `TEST_kisaki/_experiment`의 crop/CCIP 구현

이 단계에서는 아직 코드 수정하지 않고, 재사용 가능한 API와 필요한 최소 schema 변경을 정리한다.

### Batch 1 — 제품 런타임 재현성 (2026-09-08 독립 worker gate 통과)

- 고정 hash 모델과 정확한 reference 집합으로 독립 worker 구성
- 작은 query + refs 행렬과 실험 전체 행렬의 metric 일치
- Hina/test_3 전체 cold inference의 이미지별 distance/pass 비교
- 전처리, fallback, same-crop/distinct-reference, 오류 격리 gate
- 실행·입력·코드 fingerprint와 실제 exit code를 기록
- 이 batch는 native Tauri integration 또는 Linux 배포 완료를 의미하지 않음

### Batch 2 — Character Registry + refs (2026-09-08 격리 Rust gate 통과)

- recursive series scope와 선택적 기존 classification 대응 정보
- 캐릭터 생성/수정/비활성화
- existing asset 5장을 refs로 지정/교체
- recovery point에 포함되는 durable persistence
- 별도 character relation을 마지막 human decision에서 계산하는 저장/API 기반
- 캐릭터 11개·migration 27개·backup 14개 테스트 통과; UI·운영 migration은 미실행

### Batch 3 — 실제 series scan + cache (2026-09-08 격리 gate 통과)

- 실험 코드를 제품용 boundary로 옮기거나 안전하게 재사용
- detector/CCIP model lifecycle 정의
- embedding/detection cache
- incremental scan
- progress/cancel/failure isolation
- recommendation 결과 생성
- Rust 15개·Python 18개 통과; 실제 ONNX cold/warm·추가 자산·refs 교체 검증
- target 하나씩 스캔하고 캐릭터별 최신 결과를 메모리에 보관; Batch 4에서 시리즈 순차 분석과 다중 target 검토 연결

### Batch 4 — Review UI + batch approval (구현 및 자동 검증 완료)

- 추천 / 미확정 / 충돌 view
- 캐릭터별 필터
- masonry 재사용
- 개별 승인/거절/다른 캐릭터
- 다중 선택 일괄 승인
- 승인 시 별도 character relation과 human decision을 원자적으로 저장
- 런타임 설정은 native 파일 선택 후 실제 worker/model 검증을 통과해야 저장
- 캐릭터별 최신 결과 유지, stale 승인 거부, 판단 이력·해제 및 명시적 수동 지정 구현

### Batch 5 — 격리 native / recovery 및 승인된 실사용 검증 (복구·subprocess 통과, 실사용 미실행)

- user reject를 negative example/feedback로 기록
- 실제 series 하나에서 end-to-end 사용
- 추천 precision, 미탐 유형, 검토 시간 측정
- negative scoring 적용 여부는 별도 검증 후 결정
- v43 fixture migration, 구버전 snapshot 복원 직후 신규 API, refs 파일 누락, cache 없는 복원 검증
- active library migration/실사용 mutation은 별도 명시적 승인 후 수행

### 후속 — 선택적 트리 개선

실사용 후 필요성이 확인될 때만 `캐릭터 / 기타 분류 / 검토` 같은 의미적 grouping 또는 virtual node를 classification sidebar에 도입한다.

## 17. Codex 검토 질문

구현 전에 다음 질문에 답한다.

1. Character Registry를 별도 table로 두는 것이 현재 classification schema와 가장 안전한가?
2. refs를 stable asset ID로 참조할 때 trash/delete/restore semantics는 어떻게 해야 하는가?
3. prediction cache와 human decision을 어디까지 durable DB state로 보존해야 하는가?
4. 기존 query API로 series scope + 캐릭터 review set을 효율적으로 읽을 수 있는가?
5. scan worker를 어떤 기존 native/background pattern에 얹는 것이 가장 단순한가?
6. ONNX model 파일을 앱에서 어떻게 배포/다운로드/검증하는 것이 현재 repository 정책과 맞는가?
7. `TEST_kisaki/_experiment` 코드 중 제품 코드로 승격할 부분과 실험 전용으로 남길 부분은 무엇인가?
8. Character Lab을 기존 sidebar에 넣는 것과 독립 화면으로 두는 것 중 현재 UX에 더 자연스러운 것은 무엇인가?
9. migration 없이 prototype 가능한 경로가 있는가? 있다면 최종 durable 설계와 어떤 차이가 있는가?
10. PC recovery point 복원 후 refs/review 상태가 정확히 되살아나는지 어떻게 테스트할 것인가?

Codex는 이 질문에 대한 근거를 실제 코드에서 제시하고, 문서의 제안을 맹목적으로 구현하지 않는다.

## 18. MVP 완료 기준

최소 MVP는 다음을 만족해야 한다.

- 한 series에 캐릭터 2명 이상 등록 가능
- 각 캐릭터 refs 5장 지정/교체 가능
- series 내부 asset만 분석
- frozen `YOLOX + CCIP + same-crop 2-of-5` baseline 재현
- 캐시 재실행 시 기존 asset inference 재사용

- 추천 / 미확정 / 충돌 상태를 구분
- 추천 여러 장 일괄 승인 가능
- 승인 시 별도 character relation이 idempotent하게 적용
- 거절을 human decision으로 보존
- 기존 asset 원본과 unrelated classification을 변경하지 않음
- 한 이미지에 여러 character relation 허용
- app restart 후 registry/refs/human decision 보존; 미검토 prediction은 캐시 재분석으로 복원
- PC recovery point에 필요한 durable state 포함
- 기존 Cloud replication, Capture, Android, Collection 동작에 regression 없음

## 19. 실제 사용 acceptance 제안

첫 실사용은 이미 자료가 많은 한 series로 제한한다. `리버스`처럼 사용자가 이미 1차 분류한 범위가 적합하다.

예시 acceptance:

1. 기존 캐릭터 classification 3~5개를 Character Registry에 연결한다.
2. 각 캐릭터 refs 5장을 기존 asset에서 지정한다.
3. series 전체 scan을 실행한다.
4. 캐시 재실행 시간과 새 asset 증분 scan을 확인한다.
5. 캐릭터별 추천을 사람이 실제로 검토한다.
6. FP, FN, 충돌, 다인 이미지 사례를 기록한다.
7. 20장 이상을 multi-select로 승인하고 Character Lab 목록/count가 일치하며 기존 폴더 membership/count는 유지되는지 확인한다.
8. 앱 재시작 후 승인/거절/미검토 상태가 유지되는지 확인한다.
9. 필요하면 PC recovery point를 새로 만든 뒤 restore fixture 또는 안전한 복구 테스트로 durable state를 확인한다.

실사용 결과가 만족스럽기 전에는 자동 확정 모드를 기본값으로 추가하지 않는다.

## 20. Codex에게 요청하는 최종 산출물

이 문서를 읽은 Codex는 먼저 **read-only architecture review**를 수행하고 다음을 사용자에게 보고한다.

- 현재 코드에서 그대로 재사용할 수 있는 부분
- 필요한 최소 schema/API/UI 변경
- 위험한 가정 또는 이 문서에서 수정해야 할 부분
- migration/backup/recovery 영향
- 성능/모델 배포 방식
- 단계별 구현 batch와 각 batch의 test/acceptance gate

그 검토가 끝난 뒤에만 실제 구현 범위를 확정한다.

## 최종 제품 방향 한 줄

**선택 classification의 recursive subtree를 hard scope로 삼고, 명시적으로 등록한 캐릭터 refs를 동결된 `YOLOX crop + CCIP + same-crop 2-of-5 consensus`로 비교한 뒤, Character Lab에서 검토하여 별도 character relation으로 승인한다. 기존 폴더와 단일 직접 classification 소속은 유지한다.**
