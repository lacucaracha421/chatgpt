# 자동 캐릭터 crop + CCIP A/B 실험

상태: 독립 실험. 기존 `public/data.json`과 검토 기록은 변경하지 않습니다.

## 목적

기존 whole-image CCIP의 다인 이미지 약점을 줄일 수 있는지 확인합니다.
이미지마다 애니 캐릭터 detector로 사람 영역을 자동 검출하고, 여백을 둔 crop별로
기존 `ccip-caformer_b36-24` 특징을 추출합니다.

세 전략을 같은 고정 참조/정답/기준선으로 비교합니다.

- `whole`: 기존 전체 이미지 CCIP
- `crop`: 검출된 character crop들 중 최소 거리. 검출 실패 시 whole fallback
- `hybrid`: whole + crop을 모두 후보로 두고 최소 거리

이 결과는 현재 데이터셋에 대한 A/B 실험이며 전체 Lakomics 정확도로 일반화하지 않습니다.

## 실행

```powershell
& 'C:\chatgpt\TEST_kisaki\_experiment\run-crop.ps1'
```

결과만 다시 보려면:

```powershell
& 'C:\chatgpt\TEST_kisaki\_experiment\run-crop.ps1' -ServeOnly
```

브라우저: `http://127.0.0.1:1441/crop-report.html`

## 2026-09-07 첫 전체 실행

현재 누적 자료 212장에 대해 detector가 212장 모두에서 character 영역을 찾았습니다.
총 490개 crop이 생성됐고, 2개 이상 character 영역이 잡힌 이미지는 124장이었습니다.
검출 실패 시 whole-image로 돌아가는 fallback은 구현돼 있지만 이번 자료에서는 0장이었습니다.

기존 고정 평가 방식(참조 후보 5개의 duplicate group 제외)은 에이메스 25장 + 비교 182장입니다.
기존 CCIP 공개 기준선 `0.213231...`을 그대로 적용한 5-ref 결과:

| 전략 | 발견 | 오탐 | 놓침 | AP |
|---|---:|---:|---:|---:|
| whole | 19 / 25 | 0 | 6 | 0.871 |
| crop | 23 / 25 | 4 | 2 | 0.969 |
| hybrid | 23 / 25 | 5 | 2 | 0.973 |

따라서 crop은 이 자료에서 순위 품질과 recall을 분명히 높였지만,
여러 crop 중 최소 거리를 쓰면서 기존 pair 기준선이 느슨해져 오탐도 늘었습니다.
오탐 crop을 직접 확인한 결과 detector confidence는 약 0.92~0.97이었고 실제 인물 영역을 잡았습니다.
즉 관찰된 주요 오탐은 낮은 detector confidence보다 CCIP의 유사 캐릭터 거리와 기준선 문제에 가깝습니다.

### 탐색용 기준선

같은 212장 평가 자료를 보면서 5-ref 기준선을 탐색하면 crop/hybrid 모두 약 `0.1624`에서
23 / 25 발견, 오탐 0, 놓침 2가 됩니다. 그러나 이 값은 **같은 평가 자료에 맞춘 값**입니다.
독립적인 새 자료에서 검증하기 전에는 일반 기준선이나 실제 정확도로 간주하지 않습니다.
A/B 화면에도 이 수치는 `same-data exploratory only` 성격으로 별도 표시합니다.

### 구현·무결성 확인

- 기존 whole-image 거리행렬은 변경하지 않습니다.
- 새 run에서 whole-image 재구성 거리와 기존 `data.json`의 최대 차이는 약 `8.94e-08`이었습니다.
- 원본 이미지 SHA-256을 실행 후 다시 확인하며, 원본 파일은 수정하지 않습니다.
- detector 결과는 `detection-cache/`, crop CCIP 특징은 `crop-cache/`에 캐시합니다.
- detector ONNX와 CCIP ONNX는 `models/*.onnx`로 Git 추적에서 제외됩니다.
- crop 미리보기는 `public/crops/`에만 생성되며 Git 추적에서 제외됩니다.
- 첫 전체 완료 후 동일 설정의 캐시 재실행은 약 26초였습니다.

## 독립 검증 업데이트

고정 파라미터로 Hina와 `test_3`을 별도 검증했다. 현재 가장 일관된 주력 후보는 **same-crop 2-of-5 consensus**다. `whole OR consensus`는 독립 검증에서 whole-image 오탐을 다시 살려 주력 후보에서 제외했다. 세부 수치와 `test_3` 라벨 수정 후 해석은 [검증 정리](CHARACTER-CROP-CONSENSUS-VALIDATION-20260907.md)를 기준으로 한다.

새 데이터셋은 `refs/`, `target/`, `others/` 구조로 만들고 다음처럼 고정 규칙을 재현한다. refs가 5장을 넘으면 파일명 정렬 기준 앞 5장을 사용하고 나머지는 report에 기록한다.

```powershell
& 'C:\chatgpt\TEST_kisaki\_experiment\.venv\Scripts\python.exe' `
  'C:\chatgpt\TEST_kisaki\_experiment\verify_fixed.py' `
  'C:\chatgpt\test_new'
```

기본 출력은 데이터셋 루트의 `verification-fixed-report.json`이다. 결과를 보고 threshold나 consensus 수를 바꾼 뒤 같은 데이터에 재평가한 값은 독립 검증으로 취급하지 않는다.
