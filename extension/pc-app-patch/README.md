# PC Lakomics X video ingestion patch

> Historical patch record: the video-ingestion changes are already incorporated in the current `app/src-tauri/src/extension_api.rs`. Do not apply this legacy patch to the current checkout. Original context and commands below are retained for history; [the X Collector reference](../../docs/edge-extension.md) owns current behavior.

현재 PC Lakomics의 `/v1/ingestions` 확장 API는 `pbs.twimg.com` 이미지만 허용하고 임시 파일을 항상 `.png`로 만들기 때문에, 확장이 X의 `video.twimg.com/*.mp4` URL을 정상적으로 해석해도 PC 앱이 거부합니다.

Lakomics 라이브러리의 일반 `ingest_media()` 경로 자체는 MP4 비디오를 이미 지원하므로, 이 패치는 extension API의 원격 미디어 게이트만 최소 수정합니다.

## 적용

리포지토리 루트에서:

```powershell
git apply .\pc-video-ingestion.patch
cargo test --manifest-path .\app\src-tauri\Cargo.toml extension_api
```

그 다음 PC Lakomics 앱을 다시 빌드/실행해야 확장 프로그램의 X 영상 수집이 실제 라이브러리 ingestion으로 이어집니다.

## 변경 내용

- `video.twimg.com` 허용
- `.mp4` URL은 임시 `.mp4` 파일로 저장
- 원격 영상 최대 2 GiB
- 기존 `pbs.twimg.com` 이미지 경로는 그대로 유지
