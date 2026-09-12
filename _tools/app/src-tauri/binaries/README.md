# FFmpeg Windows sidecars

Lakomics는 Windows x86_64에서 FFmpeg와 FFprobe를 Tauri sidecar로 묶습니다. 실행 파일과 DLL은 저장소에 커밋하지 않고 다음 명령으로 고정된 배포본을 내려받습니다.

```powershell
cd C:\chatgpt
powershell -ExecutionPolicy Bypass -File scripts/fetch-ffmpeg-windows.ps1
```

검증만 다시 실행하려면 `-VerifyOnly`를 사용합니다. 스크립트는 다운로드한 ZIP의 SHA-256, 실행 가능 여부, GPL/nonfree 비활성화, `h264_mf`와 AAC encoder 존재를 확인합니다.

Tauri가 요구하는 실행 파일 이름은 다음과 같습니다.

- `ffmpeg-x86_64-pc-windows-msvc.exe`
- `ffprobe-x86_64-pc-windows-msvc.exe`

공유 DLL은 같은 폴더에 설치되며 애플리케이션 번들에서는 실행 파일과 같은 위치에 배치됩니다.
