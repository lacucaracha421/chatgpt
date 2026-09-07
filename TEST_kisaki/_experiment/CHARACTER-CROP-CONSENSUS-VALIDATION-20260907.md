# CCIP 자동 캐릭터 crop + 2-of-5 consensus 검증 정리

상태: **연구 결과 / Lakomics 통합 전 후보 설계**
날짜: 2026-09-07

이 문서는 `ccip-caformer_b36-24` 기반 반자동 캐릭터 분류에 자동 캐릭터 crop과 다중 참조 consensus를 붙인 실험 결과를 정리한다. 현재 Lakomics 본체에 채택하거나 배포했다는 뜻은 아니다.

## 현재 가장 유망한 규칙

```text
이미지
  -> YOLOX-s anime character detector
  -> 검출된 각 character box에 18% 여백 crop
  -> crop별 CCIP embedding
  -> 같은 query crop이 refs 5장 중 2장 이상과
     CCIP 거리 0.2132311898 이하인지 확인
  -> 통과하면 자동 후보, 아니면 검토함
```

현재는 **whole-image OR 조건을 최종 규칙으로 권장하지 않는다.** 개발 데이터에서는 recall을 보완했지만 Hina와 test_3에서 whole-image 오탐을 다시 살리는 문제가 확인됐다.

## 고정 모델·파라미터

- CCIP: `deepghs/ccip_onnx` / `ccip-caformer_b36-24`
- CCIP revision: `eb2acdd29af1703388d3d0c04221add322bc9110`
- character detector: `ksasao/anime-character-detector` YOLOX-s ONNX
- detector commit: `815aeced8ed86081f251e7383d2a50a5a6d29b54`
- detector score threshold: `0.30`
- NMS: `0.45`
- crop margin: `18%`
- max boxes per image: `8`
- CCIP threshold: `0.21323118981474148`

## 1. 개발 데이터: 기존 212장 실험

이 데이터는 규칙을 만들고 조정하는 데 사용했으므로 **독립 검증셋이 아니다.**

- 전체 이미지: 212장
- 고정 평가: target 25장 + other 182장 (refs duplicate group 제외)
- detector 성공: 212 / 212
- 총 crop: 490
- 2개 이상 character가 검출된 이미지: 124장

5 refs + 공개 CCIP threshold에서:

| 전략 | 발견 | 오탐 | 놓침 | AP |
|---|---:|---:|---:|---:|
| whole | 19 / 25 | 0 | 6 | 0.871 |
| crop-min | 23 / 25 | 4 | 2 | 0.969 |
| crop 2-of-5 consensus | 22 / 25 | 0 | 3 | 0.990 |
| guarded hybrid (whole OR consensus2) | 23 / 25 | 0 | 2 | 0.985 |

자동 crop은 다인·작은 캐릭터에서 recall을 크게 올렸지만, 단순 `crop-min`은 비교 기회가 늘면서 오탐도 증가했다. 같은 query crop이 둘 이상의 refs와 일치해야 한다는 consensus 조건은 이 오탐을 억제했다.

시간순으로 뒤늦게 추가된 난이도 높은 target 9장에서는 whole이 3 / 9, crop-min과 consensus2가 각각 7 / 9를 찾았다. 별도로 뒤늦게 추가된 other 55장에서는 consensus2 오탐이 0장이었다.

다만 이 개발 데이터에서 `guarded hybrid`가 좋아 보였던 결과는 이후 독립 검증에서 일반화되지 않았다.

## 2. 독립 검증 A: Hina

고정 규칙과 고정 threshold를 그대로 사용했다. 이 데이터 결과를 보고 파라미터를 다시 맞추지 않았다.

- refs: 5장
- target: 19장
- other 이미지: 109장
- 영상 8개 제외
- cross-folder exact duplicate: 0

| 전략 | TP | FP | FN | Precision | Recall | F1 |
|---|---:|---:|---:|---:|---:|---:|
| whole | 18 | 6 | 1 | 75.0% | 94.7% | 0.837 |
| crop-min | 18 | 6 | 1 | 75.0% | 94.7% | 0.837 |
| **crop 2-of-5 consensus** | **18** | **4** | **1** | **81.8%** | **94.7%** | **0.878** |
| guarded hybrid | 18 | 6 | 1 | 75.0% | 94.7% | 0.837 |

Hina에서는 consensus2가 recall을 잃지 않으면서 오탐을 6 -> 4로 줄였지만, 완전히 제거하지는 못했다. 오탐 일부는 금발/황금색 눈 등 target과 외형적으로 가까운 다른 캐릭터였다.

이 결과 때문에 `whole OR consensus2`는 주력 후보에서 제외했다. whole branch가 이미 틀린 이미지를 OR 조건으로 다시 통과시키기 때문이다.

Hina에서 놓친 target은 1장이었다. 따라서 현재 시스템은 '완전 자동 분류'보다 **고신뢰 자동 후보 + 나머지 검토함** 용도로 보는 것이 맞다.

## 3. 독립 검증 B: test_3

원본 report는 refs 5, target 12, others 86으로 실행됐다. 실행 후 `others/HAzQJW1aMAAD_IQ.webp`가 사용자 확인으로 **실제로는 target과 같은 캐릭터**였음이 확인됐다.

따라서 아래 '수정 후 해석'은 이 한 장을 `other -> target`으로 재라벨링해 계산한 값이다. 원본 JSON 자체의 라벨과 수치는 보존한다.

수정 후 실제 구성:

- refs: 5장
- target: 13장
- other 이미지: 85장
- cross-folder exact duplicate: 0

| 전략 | TP | FP | FN | Precision | Recall | F1 |
|---|---:|---:|---:|---:|---:|---:|
| whole | 10 | 2 | 3 | 83.3% | 76.9% | 0.800 |
| crop-min | 12 | 2 | 1 | 85.7% | 92.3% | 0.889 |
| **crop 2-of-5 consensus** | **11** | **0** | **2** | **100%** | **84.6%** | **0.917** |
| guarded hybrid | 11 | 2 | 2 | 84.6% | 84.6% | 0.846 |

잘못 `other`로 라벨된 `HAzQJW1aMAAD_IQ.webp`의 consensus2 거리는 `0.16668`로 threshold보다 충분히 낮았다. 즉 해당 건은 모델 오탐이 아니라 데이터 라벨 오류였다.

consensus2가 놓친 두 target 중 하나(`HOeidpGbIAArRBI.jfif`)는 consensus2 `0.21771`로 threshold를 약 0.00448 초과했다. 다른 하나(`x_ammi109_...jpg`)는 consensus2 `0.25811`로 더 멀었다.

## 4. 현재 결론

독립 검증 두 세트(Hina + 수정된 test_3)를 단순 합산하면 consensus2는 target 32장 중 29장을 찾고, other 194장 중 4장을 오탐했다.

이 단순 합산값은 표본이 작고 사용자가 고른 자료이므로 일반 정확도 추정치로 쓰지 않는다. 다만 서로 다른 캐릭터/자료에서도 동일한 규칙이 반복해서 작동했다는 정성적 근거로는 의미가 있다.

현재 가장 일관된 관찰:

1. **자동 character crop은 실제로 도움된다.** 다인 이미지나 캐릭터가 작게 나온 이미지에서 whole-image CCIP보다 recall이 좋아지는 사례가 반복됐다.
2. **단순 crop-min은 공격적이다.** recall은 높지만 여러 crop × 여러 refs 중 우연한 근접값 때문에 오탐이 늘 수 있다.
3. **2-of-5 same-crop consensus가 현재 가장 균형이 좋다.** 같은 query crop이 서로 다른 refs 둘 이상과 가까워야 하므로 단일 우연 일치를 억제한다.
4. **whole OR consensus는 보류한다.** whole-image 자체의 오탐을 다시 살린다.
5. **CCIP 자체의 identity 한계는 남는다.** 극단적 포즈·강한 스타일 변형·흑백/선화·외형이 매우 비슷한 다른 캐릭터가 어려운 사례로 반복 관찰됐다.

## 5. 제품 적용 시 권장 UX

현재 성능 수준에서는 자동으로 파일을 최종 폴더에 확정 이동시키는 것보다 다음 구조가 안전하다.

```text
고신뢰 consensus2 통과
  -> '추천 분류' 또는 '검토 대기'에 미리 묶음
  -> 사용자가 일괄 승인

미통과
  -> 미분류/검토함 유지
```

즉 목표는 100% 무인 태깅이 아니라 **사용자가 수십~수백 장을 하나씩 찾는 일을 크게 줄이는 반자동 분류**다.

## 6. 다음 검증 순서

1. 현재 파라미터와 `2-of-5 consensus` 규칙을 **동결**한다.
2. Hina의 실제 오탐 4장을 negative example로 활용하는 실험은 별도 branch/실험으로만 진행한다.
3. negative feedback를 썼다면 그 효과를 같은 데이터에 다시 맞춰 평가하지 말고, **세 번째/네 번째 새 캐릭터 데이터셋**에서 재검증한다.
4. 흑백/선화, SD/chibi, 극단적 의상/폼 체인지, 다인 이미지 등 실패 유형을 별도 태그로 기록해 유형별 recall을 본다.
5. 실제 Lakomics 통합 전에는 '자동 확정'과 '추천 후보'의 위험도를 분리하고, 기본값은 추천/일괄 승인으로 둔다.

## 7. 재현·근거 파일

주요 구현 및 개발 실험:

- `crop_ccip.py`
- `crop_consensus.py`
- `crop_timeline.py`
- `crop_miss_probe.py`
- `verify_fixed.py` — `refs/target/others` 데이터셋용 고정 규칙 검증기
- `test_crop_ccip.py`
- `CROP-README.md`
- `crop-report.json`
- `crop-consensus-report.json`
- `crop-timeline-report.json`
- `crop-miss-probe.json`

독립 검증 원본 report:

- `C:\chatgpt\test_hina\verification-fixed-report.json`
- `C:\chatgpt\test_3\verification-fixed-report.json`

주의: `test_3` 원본 report는 `HAzQJW1aMAAD_IQ.webp`를 `other`로 기록하고 있다. 본 문서는 이후 사용자 확인을 반영해 해당 이미지를 target으로 재해석한 결과를 별도로 기록했다. 원본 report를 소급 수정하지 않았다.

## 최종 한 줄

**현재 Lakomics 캐릭터 반자동 분류의 1순위 후보는 `YOLOX character crop + CCIP + 5 refs 중 same-crop 2-reference consensus`이며, 자동 확정보다 고신뢰 추천 + 일괄 승인 UX에 적합하다.**
